/* PDF 重排翻译引擎：BabelDOC / PDFMathTranslate(pdf2zh)
 * 设计参考：
 *  - funstory-ai/BabelDOC、Byaidu/PDFMathTranslate 的 CLI 契约（参数取自各自源码/文档）
 *  - 子进程写法照 Zotero 源码 Zotero.Utilities.Internal.assessAppBundle()：
 *    Subprocess.call + 流式读 stdout/stderr + wait() 取 exitCode
 *  - 任务串行队列 + 完成通知（Zotero.ProgressWindow）
 */

if (typeof Zotero == 'undefined') {
	var Zotero;
}

var ZHInfoEngine;

ZHInfoEngine = {
	_jobs: null,
	_queue: null,
	_active: null,

	init() {
		this._jobs = new Map();
		this._queue = [];
		this._active = null;
	},

	shutdown() {
		this._queue = [];
		if (this._active) {
			this._active.aborted = true;
			this._kill(this._active.proc);
		}
		this._active = null;
		if (this._jobs) this._jobs.clear();
	},

	// ------------------------------------------------------------ 路径与探测

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
		const sep = Zotero.isWin ? '\\' : '/';
		const ext = Zotero.isWin ? '.exe' : '';
		const bin = [home, '.local', 'bin'].join(sep);
		const order = String(ZHInfo.pref('pdfEngine', 'auto'));
		const names = [];
		if (order === 'pdf2zh') names.push('pdf2zh', 'babeldoc');
		else if (order === 'babeldoc') names.push('babeldoc', 'pdf2zh');
		else names.push('babeldoc', 'pdf2zh');
		return names.map(n => bin + sep + n + ext);
	},

	engineIdOf(path) {
		if (/pdf2zh/i.test(path)) return 'pdf2zh';
		if (/babeldoc/i.test(path)) return 'babeldoc';
		return 'babeldoc';
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
		return { ok: !!exe, exe, engine: exe ? this.engineIdOf(exe) : null };
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

	_langOut() {
		const t = String(ZHInfo.pref('targetLang', 'zh-CN'));
		return t.toLowerCase().startsWith('zh') ? 'zh' : t;
	},

	_pagesArg(startPage, limit) {
		if (limit === Infinity || !limit) return null;
		const from = Math.max(1, startPage || 1);
		const to = from + limit - 1;
		return to > from ? (from + '-' + to) : String(from);
	},

	/** 返回 { args, environment } */
	buildInvocation({ exe, engine, pdfPath, outDir, startPage, limit, caps }) {
		caps = caps || {};
		const cfg = this._llmConfig();
		const langIn = String(ZHInfo.pref('engineLangIn', 'en'));
		const thread = String(ZHInfo.pref('engineThread', 4));
		const pages = this._pagesArg(startPage, limit);
		const args = [];
		const environment = {};
		let environmentAppend = false;

		if (engine === 'pdf2zh') {
			args.push(pdfPath);
			if (pages) args.push('-p', pages);
			args.push('-li', langIn);
			args.push('-lo', this._langOut());
			const service = (String(ZHInfo.pref('pdf2zhService', 'openai')).trim() || 'openai').toLowerCase();
			args.push('-s', service + (cfg.model ? (':' + cfg.model) : ''));
			args.push('-o', outDir);
			args.push('-t', thread);
			if (ZHInfo.pref('engineSkipScanned', false) && caps.ultrafast) args.push('--ultrafast');
			// pdf2zh 的 OpenAI 系翻译器从环境变量取凭据
			environmentAppend = true;
			environment.OPENAI_API_KEY = cfg.key || '';
			environment.OPENAI_BASE_URL = cfg.base || '';
			environment.OPENAI_MODEL = cfg.model || '';
			environment.OPENAI_API_BASE = cfg.base || '';
			return { args, environment, environmentAppend };
		}

		// BabelDOC
		args.push('--files', pdfPath);
		if (pages) args.push('--pages', pages);
		args.push('--lang-in', langIn);
		args.push('--lang-out', String(ZHInfo.pref('targetLang', 'zh-CN')));
		args.push('--openai');
		args.push('--openai-model', cfg.model);
		if (cfg.base) args.push('--openai-base-url', cfg.base);
		if (cfg.key) args.push('--openai-api-key', cfg.key);
		args.push('--watermark-output-mode', 'no_watermark');
		args.push('--output', outDir);
		if (caps.qps) args.push('--qps', thread);
		if (ZHInfo.pref('engineSkipScanned', false)) args.push('--skip-scanned-detection');
		return { args, environment, environmentAppend };
	},

	// ------------------------------------------------------------ 能力探测

	_helpCache: null,

	/** 读一次 --help，判断该版本支持哪些开关（不同版本差异很大） */
	async caps(exe) {
		if (!this._helpCache) this._helpCache = new Map();
		if (this._helpCache.has(exe)) return this._helpCache.get(exe);
		let text = '';
		try {
			text = await Zotero.Utilities.Internal.subprocess(exe, ['--help']);
		}
		catch (e) {
			try {
				text = await Zotero.Utilities.Internal.subprocess(exe, ['-h']);
			}
			catch (e2) {
				text = '';
			}
		}
		const c = {
			qps: /--qps/.test(text),
			ultrafast: /--ultrafast/.test(text),
			mode: /--mode/.test(text),
			pages: /--pages/.test(text),
			skipScanned: /--skip-scanned-detection/.test(text),
		};
		this._helpCache.set(exe, c);
		Zotero.debug('ZhInfo: engine caps ' + JSON.stringify(c));
		return c;
	},

	/** 引擎自检：路径、类型、版本、能力位（给设置面板的「测试引擎」用） */
	async describe() {
		const av = await this.available();
		if (!av.ok) {
			return { ok: false, text: '未找到引擎可执行文件。请安装：uv tool install --python 3.12 --with "bitstring' + String.fromCharCode(60) + '5" BabelDOC，或在设置里填写路径' };
		}
		let version = '';
		try {
			version = String(await Zotero.Utilities.Internal.subprocess(av.exe, ['--version'])).trim().slice(0, 80);
		}
		catch (e) {
			version = '(取版本失败)';
		}
		let caps = {};
		try {
			caps = await this.caps(av.exe);
		}
		catch (e) { /* ignore */ }
		const cfg = this._llmConfig();
		return {
			ok: true,
			text: '引擎=' + av.engine + ' 路径=' + av.exe + ' 版本=' + version
				+ ' 支持开关=' + JSON.stringify(caps)
				+ ' 模型接口=' + (cfg.base ? cfg.base : '(未配置)'),
		};
	},

	// ------------------------------------------------------------ 队列

	isRunning(attachmentID) {
		if (this._active && this._active.attachmentID === attachmentID) return true;
		return !!(this._queue || []).some(j => j.attachmentID === attachmentID);
	},

	queueLength() {
		return (this._queue ? this._queue.length : 0) + (this._active ? 1 : 0);
	},

	/** 入队（后台串行执行），返回 Promise */
	enqueue({ attachment, startPage, limit, onProgress, quiet }) {
		const key = attachment.id;
		if (this.isRunning(key)) {
			throw new Error('该文献已有引擎任务在队列中');
		}
		let resolveFn;
		let rejectFn;
		const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
		const job = {
			attachmentID: key,
			attachment,
			startPage,
			limit,
			onProgress,
			quiet,
			aborted: false,
			proc: null,
			resolve: resolveFn,
			reject: rejectFn,
		};
		this._queue.push(job);
		Zotero.debug('ZhInfo: engine queued, total=' + this.queueLength());
		this._pump();
		return promise;
	},

	async _pump() {
		if (this._active || !this._queue.length) return;
		const job = this._queue.shift();
		this._active = job;
		try {
			const res = await this._exec(job);
			job.resolve(res);
		}
		catch (e) {
			job.reject(e);
		}
		finally {
			this._active = null;
			this._pump();
		}
	},

	_kill(proc) {
		if (!proc) return;
		try {
			proc.kill(0);
			return;
		}
		catch (e) { /* ignore */ }
		try {
			proc.forceQuit(0);
		}
		catch (e) { /* ignore */ }
	},

	abort(attachmentID) {
		if (this._active && this._active.attachmentID === attachmentID) {
			this._active.aborted = true;
			this._kill(this._active.proc);
			return true;
		}
		const idx = (this._queue || []).findIndex(j => j.attachmentID === attachmentID);
		if (idx > -1) {
			const job = this._queue.splice(idx, 1)[0];
			job.aborted = true;
			job.reject(new Error('已取消（尚未开始）'));
			return true;
		}
		return false;
	},

	notify(headline, body, isError) {
		try {
			const pw = new Zotero.ProgressWindow({ closeOnClick: true });
			pw.changeHeadline(headline);
			if (body) pw.addDescription(String(body).slice(0, 180));
			pw.show();
			pw.startCloseTimer(isError ? 12000 : 8000);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// ------------------------------------------------------------ 执行

	async _execInner(job) {
		const attachment = job.attachment;
		const av = await this.available();
		if (!av.ok) {
			throw new Error('未检测到翻译引擎：请安装 BabelDOC（uv tool install --python 3.12 --with "bitstring@LT@5" BabelDOC）或 pdf2zh，或在设置里填写可执行文件路径'.replace('@LT@', String.fromCharCode(60)));
		}
		const cfg = this._llmConfig();
		if (!cfg.base || !cfg.key) {
			throw new Error('引擎需要大模型接口：请先在设置里填写 Base URL 与 API Key');
		}

		const pdfPath = await attachment.getFilePathAsync();
		if (!pdfPath) throw new Error('取不到 PDF 文件路径');

		const outDir = PathUtils.join(Zotero.getTempDirectory().path, 'zhinfo-' + attachment.id + '-' + Date.now());
		await IOUtils.makeDirectory(outDir, { createAncestors: true });
		job.outDir = outDir;

		const caps = await this.caps(av.exe);
		const inv = this.buildInvocation({
			exe: av.exe,
			engine: av.engine,
			pdfPath,
			outDir,
			startPage: job.startPage,
			limit: job.limit,
			caps,
		});

		const Subprocess = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs').Subprocess;
		Zotero.debug('ZhInfo: engine[' + av.engine + '] ' + av.exe + ' ' + inv.args.join(' '));

		const callOpts = {
			command: av.exe,
			arguments: inv.args,
			stderr: 'pipe',
		};
		if (inv.environmentAppend && Object.keys(inv.environment).length) {
			callOpts.environmentAppend = true;
			callOpts.environment = inv.environment;
		}

		const proc = await Subprocess.call(callOpts);
		job.proc = proc;

		let tail = '';
		const pump = async (stream) => {
			try {
				let str;
				while ((str = await stream.readString())) {
					tail = (tail + str).slice(-4000);
					if (job.onProgress) {
						try {
							job.onProgress(str);
						}
						catch (e) { /* ignore */ }
					}
				}
			}
			catch (e) { /* closed */ }
		};

		const pOut = pump(proc.stdout);
		const pErr = proc.stderr ? pump(proc.stderr) : Promise.resolve();

		const { exitCode } = await proc.wait();
		await Promise.all([pOut, pErr]);
		job.proc = null;

		if (job.aborted) throw new Error('已取消');
		if (exitCode !== 0) throw new Error('引擎退出码 ' + exitCode + '：' + tail.slice(-400));

		const produced = await this._pickOutput(outDir, pdfPath);
		if (!produced) throw new Error('引擎未产出 PDF：' + tail.slice(-400));

		const created = await this._importResult(attachment, produced);
		if (!job.quiet) {
			this.notify('双语 PDF 已生成', Zotero.Items.get(attachment.id).getField('title') || '');
		}
		return { attachment: created, file: produced };
	},

	/** 执行任务并保证清掉中间产物目录（PDF 已复制进 storage，原样保留在 job 里只用于排错日志） */
	async _exec(job) {
		try {
			return await this._execInner(job);
		}
		finally {
			if (job.outDir) {
				try {
					await IOUtils.remove(job.outDir, { recursive: true, ignoreAbsent: true });
					Zotero.debug('ZhInfo: engine temp cleaned ' + job.outDir);
				}
				catch (e) {
					Zotero.logError(e);
				}
				job.outDir = null;
			}
		}
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
		const dual = pdfs.find(p => /dual|bi[_-]?lingual/i.test(PathUtils.filename(p)));
		return dual || pdfs[0];
	},

	async _importResult(attachment, file) {
		const att = Zotero.Items.get(attachment.id);
		const opts = { file, title: '中文双语（引擎生成）' };
		if (att && att.parentItemID) opts.parentItemID = att.parentItemID;
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