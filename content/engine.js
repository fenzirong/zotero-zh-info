/* PDF 重排翻译引擎驱动：调用开源 BabelDOC / PDFMathTranslate CLI 生成「保留原版面」的双语 PDF
 * 参考：funstory-ai/BabelDOC（沉浸式翻译官方开源后端）、Byaidu/PDFMathTranslate
 * 子进程写法照 Zotero 源码 Zotero.Utilities.Internal.assessAppBundle()：Subprocess.call + 流式读 stdout + wait() 取 exitCode
 */

if (typeof Zotero == 'undefined') {
	var Zotero;
}

var ZHInfoEngine;

ZHInfoEngine = {
	_jobs: null,

	init() {
		this._jobs = new Map();
	},

	shutdown() {
		if (!this._jobs) return;
		for (let job of this._jobs.values()) {
			try {
				job.proc.forceQuit(0);
			}
			catch (e) { /* ignore */ }
		}
		this._jobs.clear();
	},

	// ------------------------------------------------------------ 路径

	_home() {
		try {
			return Services.dirsvc.get('Home', Ci.nsIFile).path;
		}
		catch (e) {
			return null;
		}
	},

	_candidateExes() {
		const home = this._home();
		if (!home) return [];
		const ext = Zotero.isWin ? '.exe' : '';
		const bin = [home, '.local', 'bin'].join(Zotero.isWin ? '\\' : '/');
		const sep = Zotero.isWin ? '\\' : '/';
		const list = [];
		list.push(bin + sep + 'babeldoc' + ext);
		list.push(bin + sep + 'pdf2zh' + ext);
		list.push(bin + sep + 'pdf2zh_next' + ext);
		return list;
	},

	async resolveExe() {
		const pref = String(ZHInfo.pref('pdfEnginePath', '') || '').trim();
		if (pref) {
			try {
				if (await IOUtils.exists(pref)) return pref;
			}
			catch (e) { /* ignore */ }
		}
		for (let p of this._candidateExes()) {
			try {
				if (await IOUtils.exists(p)) return p;
			}
			catch (e) { /* ignore */ }
		}
		return null;
	},

	async available() {
		const exe = await this.resolveExe();
		return { ok: !!exe, exe };
	},

	// ------------------------------------------------------------ 参数

	_llmConfig() {
		let base = String(ZHInfo.pref('llm.baseURL', '') || '').trim().replace(/\/+$/, '');
		if (base && !/\/v\d+$/.test(base) && !/\/chat\/completions$/i.test(base)) base += '/v1';
		return {
			base,
			key: String(ZHInfo.pref('llm.apiKey', '') || '').trim(),
			model: String(ZHInfo.pref('llm.model', '') || '').trim() || 'deepseek-chat',
		};
	},

	_pagesArg(startPage, limit) {
		if (limit === Infinity || !limit) return null;
		const from = Math.max(1, startPage || 1);
		const to = from + limit - 1;
		return to > from ? (from + '-' + to) : String(from);
	},

	buildArgs({ exe, pdfPath, outDir, startPage, limit }) {
		const cfg = this._llmConfig();
		const isBabel = /babeldoc/i.test(exe);
		const args = [];

		if (isBabel) {
			args.push('--files', pdfPath);
			const pg = this._pagesArg(startPage, limit);
			if (pg) args.push('--pages', pg);
			args.push('--lang-in', String(ZHInfo.pref('engineLangIn', 'en')));
			args.push('--lang-out', String(ZHInfo.pref('targetLang', 'zh-CN')));
			args.push('--openai');
			args.push('--openai-model', cfg.model);
			if (cfg.base) args.push('--openai-base-url', cfg.base);
			if (cfg.key) args.push('--openai-api-key', cfg.key);
			args.push('--watermark-output-mode', 'no_watermark');
			args.push('--output', outDir);
			if (ZHInfo.pref('engineSkipScanned', false)) args.push('--skip-scanned-detection');
			args.push('--report-interval', '2');
			return args;
		}

		// pdf2zh / pdf2zh_next
		args.push(pdfPath);
		const pg2 = this._pagesArg(startPage, limit);
		if (pg2) args.push('-p', pg2);
		args.push('-li', String(ZHInfo.pref('engineLangIn', 'en')));
		args.push('-lo', String(ZHInfo.pref('targetLang', 'zh-CN')));
		args.push('-o', outDir);
		args.push('-t', '4');
		return args;
	},

	// ------------------------------------------------------------ 运行

	async run({ attachment, startPage, limit, onProgress, onDone, onError }) {
		if (!attachment) throw new Error('缺少附件');
		const jobKey = attachment.id;
		if (this._jobs.has(jobKey)) throw new Error('该文献已有翻译任务在运行');

		const av = await this.available();
		if (!av.ok) {
			throw new Error('未检测到翻译引擎：请先安装（uv tool install --python 3.12 BabelDOC），或在设置里填写可执行文件路径');
		}
		const cfg = this._llmConfig();
		if (!cfg.base || !cfg.key) {
			throw new Error('引擎需要大模型接口：请先在设置里填写 Base URL 与 API Key（引擎走 OpenAI 兼容接口）');
		}

		const pdfPath = await attachment.getFilePathAsync();
		if (!pdfPath) throw new Error('取不到 PDF 文件路径');

		const tmpRoot = Zotero.getTempDirectory();
		const outDir = PathUtils.join(tmpRoot.path, 'zhinfo-' + attachment.id + '-' + Date.now());
		await IOUtils.makeDirectory(outDir, { createAncestors: true });

		const args = this.buildArgs({ exe: av.exe, pdfPath, outDir, startPage, limit });
		const Subprocess = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs').Subprocess;

		Zotero.debug('ZhInfo: engine run ' + av.exe + ' ' + args.join(' '));
		const proc = await Subprocess.call({
			command: av.exe,
			arguments: args,
			stderr: 'pipe',
		});

		const job = { proc, outDir, aborted: false };
		this._jobs.set(jobKey, job);

		let tail = '';
		const pump = async (stream) => {
			try {
				let str;
				while ((str = await stream.readString())) {
					tail = (tail + str).slice(-4000);
					if (onProgress) {
						try {
							onProgress(str);
						}
						catch (e) { /* ignore */ }
					}
				}
			}
			catch (e) { /* stream closed */ }
		};

		const pOut = pump(proc.stdout);
		const pErr = proc.stderr ? pump(proc.stderr) : Promise.resolve();

		try {
			const { exitCode } = await proc.wait();
			await Promise.all([pOut, pErr]);
			this._jobs.delete(jobKey);

			if (job.aborted) {
				throw new Error('已取消');
			}
			if (exitCode !== 0) {
				throw new Error('引擎退出码 ' + exitCode + '：' + tail.slice(-500));
			}

			const produced = await this._pickOutput(outDir, pdfPath);
			if (!produced) {
				throw new Error('引擎未产出 PDF：' + tail.slice(-500));
			}
			const att = await this._importResult(attachment, produced);
			if (onDone) onDone(att, produced);
			return { attachment: att, file: produced };
		}
		catch (e) {
			this._jobs.delete(jobKey);
			if (onError) onError(e);
			throw e;
		}
	},

	abort(attachmentID) {
		const job = this._jobs && this._jobs.get(attachmentID);
		if (!job) return false;
		job.aborted = true;
		try {
			job.proc.kill(0);
		}
		catch (e) {
			try {
				job.proc.forceQuit(0);
			}
			catch (e2) { /* ignore */ }
		}
		this._jobs.delete(attachmentID);
		return true;
	},

	isRunning(attachmentID) {
		return !!(this._jobs && this._jobs.has(attachmentID));
	},

	async _pickOutput(outDir, inputPath) {
		let entries = [];
		try {
			entries = await IOUtils.getChildren(outDir);
		}
		catch (e) {
			return null;
		}
		const pdfs = entries.filter(p => /\.pdf$/i.test(p) && p !== inputPath);
		if (!pdfs.length) return null;
		// 优先双语版
		const dual = pdfs.find(p => /dual|bi[_-]?lingual|zh.*dual/i.test(PathUtils.filename(p)));
		return dual || pdfs[0];
	},

	async _importResult(attachment, file) {
		const att = Zotero.Items.get(attachment.id);
		const parentID = att && att.parentItemID ? att.parentItemID : null;
		const opts = { file, title: '中文双语（引擎生成）' };
		if (parentID) opts.parentItemID = parentID;
		opts.libraryID = att.libraryID;
		const created = await Zotero.Attachments.importFromFile(opts);
		try {
			created.addTag('zhinfo-translated');
			await created.saveTx();
		}
		catch (e) { /* ignore */ }
		return created;
	},
};