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

	init(env) {
		this.rootURI = (env && env.rootURI) || '';
		this.id = (env && env.id) || '';
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

	/** BabelDOC 内置 Python（uv tool 安装位置），用于跑我们的 JSONL 驱动 */
	_appDataDir() {
		try {
			if (Zotero.isWin) {
				// Windows: 用 nsIFile 取 %APPDATA%\\uv，避免依赖 process.env
				const f = Services.dirsvc.get('AppData', Ci.nsIFile);
				return f ? f.path : null;
			}
			const home = this._home();
			return home ? [home, 'Library', 'Application Support'].join('/') : null;
		}
		catch (e) {
			return null;
		}
	},

	_pythonCandidates() {
		const home = this._home();
		const sep = Zotero.isWin ? '\\' : '/';
		const ext = Zotero.isWin ? '.exe' : '';
		const list = [];
		const app = this._appDataDir();
		if (app) {
			// uv tool 默认安装在这两个位置之一
			list.push([app, 'uv', 'tools', 'babeldoc', 'Scripts', 'python' + ext].join(sep));
			list.push([app, 'uv', 'python'].join(sep));
		}
		if (home) {
			list.push([home, '.local', 'bin', 'python' + ext].join(sep));
			// uv 自己管理的 CPython
			list.push([home, 'AppData', 'Roaming', 'uv', 'python'].join(sep));
		}
		return list;
	},

	/** 目录型候选（uv 的 cpython-* 目录）下找 python.exe */
	async _findPythonInDir(dir) {
		try {
			if (!(await IOUtils.exists(dir))) return null;
			const kids = await IOUtils.getChildren(dir);
			const exe = Zotero.isWin ? 'python.exe' : 'python3';
			for (let k of kids) {
				const cand = PathUtils.join(k, exe);
				try {
					if (await IOUtils.exists(cand)) return cand;
				}
				catch (e) { /* ignore */ }
			}
		}
		catch (e) { /* ignore */ }
		return null;
	},

	async resolvePython() {
		const pref = String(ZHInfo.pref('enginePythonPath', '') || '').trim();
		if (pref) {
			try {
				if (await IOUtils.exists(pref)) return pref;
			}
			catch (e) { /* ignore */ }
		}
		for (let p of this._pythonCandidates()) {
			try {
				if (await IOUtils.exists(p)) return p;
			}
			catch (e) { /* ignore */ }
			const inDir = await this._findPythonInDir(p);
			if (inDir) return inDir;
		}
		return null;
	},

	/** 驱动脚本落盘到临时目录（内容随插件走，避免路径问题） */
	async _ensureDriver() {
		const root = this.rootURI || (Zotero.ZhInfo && Zotero.ZhInfo.rootURI) || '';
		if (!root) throw new Error('插件根路径未知，无法加载驱动脚本');
		const src = Zotero.File.getContentsFromURL(root + 'content/engine/zhinfo_driver.py');
		if (!src || !src.length) throw new Error('插件内缺少 content/engine/zhinfo_driver.py');
		const dir = PathUtils.join(Zotero.getTempDirectory().path, 'zhinfo-engine');
		await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
		const path = PathUtils.join(dir, 'zhinfo_driver.py');
		let need = true;
		try {
			const cur = await IOUtils.readUTF8(path);
			need = !cur || cur.length !== src.length;
		}
		catch (e) {
			need = true;
		}
		if (need) await IOUtils.writeUTF8(path, src);
		return path;
	},

	async available() {
		const py = await this.resolvePython();
		return { ok: !!py, exe: py, python: py, engine: 'babeldoc' };
	},

	/** 兼容旧调用：直接给引擎可执行文件路径的场景 */
	async availableLegacy() {
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

	/** 引擎页数：与阅读器"翻译页数"无关，默认整篇 */
	_engineLimit() {
		const raw = String(ZHInfo.pref('enginePages', 'all'));
		if (raw === 'all' || raw === '' ) return Infinity;
		const n = parseInt(raw, 10);
		return (isNaN(n) || n < 1) ? Infinity : n;
	},

	_pagesArg(startPage, limit) {
		if (limit === Infinity || !limit) return null;
		const from = Math.max(1, startPage || 1);
		const to = from + limit - 1;
		return to > from ? (from + '-' + to) : String(from);
	},

	_thinkingKey() {
		const cfg = this._llmConfig();
		return cfg.base + '|' + cfg.model;
	},

	/**
	 * 决定是否给引擎发 thinking 开关：
	 * auto = 先按引擎的方式发一次极短请求；若正文为空（思考把预算吃满），
	 * 再带 thinking:{type:disabled} 试探；能出正文则用 disabled，否则不发送。
	 * 结果按 (baseURL|model) 缓存到 pdf2zh/engineThinkingResolved，避免每次都探。
	 */
	async resolveThinking() {
		const mode = String(ZHInfo.pref('engineThinking', 'auto'));
		if (mode === 'disabled' || mode === 'enabled' || mode === 'none') return mode;

		const key = this._thinkingKey();
		let cached = null;
		try {
			cached = JSON.parse(String(ZHInfo.pref('engineThinkingResolved', '') || 'null'));
		}
		catch (e) { cached = null; }
		if (cached && cached.key === key && cached.value) return cached.value;

		const cfg = this._llmConfig();
		if (!cfg.base || !cfg.key) return 'none';
		const url = cfg.base.replace(/\/+$/, '') + '/chat/completions';
		const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key };

		const ask = async (extra) => {
			const body = Object.assign({ model: cfg.model, max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] }, extra);
			try {
				const xhr = await Zotero.HTTP.request('POST', url, {
					body: JSON.stringify(body),
					headers,
					responseType: 'json',
					timeout: 25000,
					successCodes: false,
				});
				if (xhr.status < 200 || xhr.status >= 300) return null;
				const j = xhr.response;
				const msg = j && j.choices && j.choices[0] && j.choices[0].message;
				return msg ? (msg.content || '') : null;
			}
			catch (e) {
				return null;
			}
		};

		let value = 'none';
		const plain = await ask({});
		if (plain !== null) {
			if (plain && String(plain).trim()) {
				value = 'none';
			}
			else {
				const off = await ask({ thinking: { type: 'disabled' } });
				if (off && String(off).trim()) value = 'disabled';
			}
		}
		try {
			Zotero.Prefs.set('extensions.zhinfo.engineThinkingResolved', JSON.stringify({ key, value, at: Date.now() }), true);
		}
		catch (e) { /* ignore */ }
		Zotero.debug('ZhInfo: thinking resolved=' + value + ' for ' + key);
		return value;
	},

	/** 返回 { args, environment } */
	buildInvocation({ exe, engine, pdfPath, outDir, startPage, limit, caps, thinking }) {
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
		if (caps.reportInterval) args.push('--report-interval', String(ZHInfo.pref('engineReportInterval', 2)));
		if ((thinking === 'disabled' || thinking === 'enabled') && caps.thinking) {
			args.push('--openai-thinking', thinking);
		}
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
			thinking: /--openai-thinking/.test(text),
			reportInterval: /--report-interval/.test(text),
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
		const drv = await this._ensureDriver().catch(() => null);
		const cfg = this._llmConfig();
		return {
			ok: true,
			text: '引擎=' + av.engine + ' 路径=' + av.exe + ' 版本=' + version
				+ ' 驱动=' + (drv || '缺失')
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

	/** 是否为本插件/引擎生成的翻译产物文件名 */
	isTranslatedName(name) {
		return /\.(no_watermark\.)?(zh|zh-CN|zh-TW)(\.[a-z\-]+)?\.(mono|dual)\.pdf$/i.test(String(name || ''));
	},

	/**
	 * 解析"真正的源 PDF 附件"：若当前附件是引擎产物（例如用户点在新生成的双语 PDF 上），
	 * 就回到同父条目下找原始 PDF。BabelDOC 拒绝翻译自己生成的文件。
	 */
	async resolveSource(attachment) {
		const att = Zotero.Items.get(attachment.id);
		if (!att) return attachment;
		const path = await att.getFilePathAsync();
		const name = path ? PathUtils.filename(path) : String(att.getField('title') || '');
		if (!this.isTranslatedName(name)) return att;

		const parentID = att.parentItemID;
		if (!parentID) return att;
		const siblings = Zotero.Items.get(parentID).getAttachments();
		const others = siblings
			.map(id => Zotero.Items.get(id))
			.filter(a => a && a.id !== att.id && a.isPDFAttachment && a.isPDFAttachment());
		// 优先未被标记为翻译产物的附件
		const raw = others.find(a => !a.getTags().some(t => t.tag === 'zhinfo-translated'));
		const chosen = raw || others[0];
		if (chosen) {
			Zotero.debug('ZhInfo: 当前附件是翻译产物，改用原始 PDF 附件 ' + chosen.id);
		}
		return chosen || att;
	},

	async _execInner(job) {
		let attachment = job.attachment;
		attachment = await this.resolveSource(attachment);
		job.attachment = attachment;
		Zotero.debug('ZhInfo: _execInner 开始 att=' + attachment.id);
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

		const thinking = await this.resolveThinking();
		const driver = await this._ensureDriver();

		let pages = 'all';
		if (job.limit && job.limit !== Infinity) {
			const from = Math.max(1, job.startPage || 1);
			const to = from + job.limit - 1;
			pages = to > from ? (from + '-' + to) : String(from);
		}

		const Subprocess = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs').Subprocess;

		// BabelDOC 的 CLI 进度条在非 TTY 环境下不输出（这就是"引擎 120 秒无输出"的根因），
		// 所以改为调用插件自带的 Python 驱动：走 BabelDOC 官方 async_translate API，
		// 以 JSONL 逐条吐出 stage / 百分比 / finish / error。
		job.python = job.python || await this.resolvePython();
		if (!job.python) {
			throw new Error('未找到 BabelDOC 的 Python 解释器：请先安装 uv tool install --python 3.12 BabelDOC，或在设置里填写 python 路径');
		}
		job.driver = driver;
		const cfg2 = this._llmConfig();
		const args = [
			driver,
			'--input', pdfPath,
			'--output', outDir,
			'--pages', pages,
			'--lang-in', String(ZHInfo.pref('engineLangIn', 'en')),
			'--lang-out', String(ZHInfo.pref('targetLang', 'zh-CN')),
			'--model', cfg2.model,
			'--base-url', cfg2.base,
			'--api-key', cfg2.key,
			'--qps', String(Number(ZHInfo.pref('engineThread', 2)) || 2),
			'--report-interval', String(Number(ZHInfo.pref('engineReportInterval', 2)) || 2),
		];
		if (thinking === 'disabled' || thinking === 'enabled') args.push('--thinking', thinking);
		if (ZHInfo.pref('engineSkipScanned', false)) args.push('--skip-scanned');

		Zotero.debug('ZhInfo: driver ' + job.python + ' ' + args.join(' '));

		const callOpts = {
			command: job.python,
			arguments: args,
			stderr: 'pipe',
		};

		let proc;
		try {
			proc = await Subprocess.call(callOpts);
		}
		catch (e) {
			throw new Error('无法启动驱动进程：' + (e && e.message ? e.message : e) + '；命令=' + job.python);
		}
		job.proc = proc;
		Zotero.debug('ZhInfo: 驱动已启动 pid=' + (proc.pid || 'n/a'));

		let tail = '';
		job.events = { finish: null, error: null };

		const handleLine = (line) => {
			const t = String(line).trim();
			if (!t || t[0] !== '{') return;
			let ev;
			try {
				ev = JSON.parse(t);
			}
			catch (e) {
				return;
			}
			if (!ev || !ev.type) return;
			if (ev.type === 'finish') {
				job.events.finish = ev;
				if (job.onProgress) job.onProgress('完成：' + (ev.dual || ev.mono || '') + (ev.seconds ? '（' + Math.round(ev.seconds) + 's）' : ''));
				return;
			}
			if (ev.type === 'error') {
				job.events.error = ev.error || '未知错误';
				if (job.onProgress) job.onProgress('错误：' + job.events.error);
				return;
			}
			if (ev.type === 'progress' && ev.stage && job.onProgress) {
				const pct = Math.round(Number(ev.pct) || 0);
				job.onProgress('[' + pct + '%] ' + ev.stage
					+ (ev.total ? '（' + (ev.cur || 0) + '/' + ev.total + '）' : ''));
				return;
			}
			if (ev.type === 'stage' && job.onProgress) {
				job.onProgress('准备：' + ev.stage);
			}
		};

		const pump = async (stream, onLine) => {
			try {
				let buf = '';
				let str;
				while ((str = await stream.readString())) {
					tail = (tail + str).slice(-3000);
					if (job._tick) job._tick();
					buf += str;
					const parts = buf.split('\n');
					buf = parts.pop();
					for (let ln of parts) onLine(ln);
				}
				if (buf) onLine(buf);
			}
			catch (e) { /* closed */ }
		};

		const pOut = pump(proc.stdout, handleLine);
		const pErr = proc.stderr ? pump(proc.stderr, () => {}) : Promise.resolve();

		// 看门狗：长时间无任何输出时，多半是被限流后指数退避重试，提示用户而不是干等
		let lastTick = Date.now();
		const stallTimer = setInterval(() => {
			if (!job.proc) return;
			if ((Date.now() - lastTick) < 120000) return;
			lastTick = Date.now();
			if (job.onProgress) {
				try {
					job.onProgress('（引擎 120 秒没有新进度：可能在重试/被限流，或版面模型加载中；可在设置里把并发线程调成 1）');
				}
				catch (e) { /* ignore */ }
			}
		}, 20000);
		const _origPumpTick = () => { lastTick = Date.now(); };
		job._tick = _origPumpTick;

		const { exitCode } = await proc.wait();
		clearInterval(stallTimer);
		await Promise.all([pOut, pErr]);
		job.proc = null;

		if (job.aborted) throw new Error('已取消');

		const ev = job.events || {};
		if (ev.error) {
			const msg = String(ev.error);
			if (/NoneType|strip|reasoning|content/i.test(msg)) {
				throw new Error('模型没有返回正文（多为推理型模型把 token 用在思考上）：' + msg
					+ '\\n请在设置 → PDF 引擎 →「引擎思考模式」选「关闭思考」后重试。');
			}
			if (/already been translated/i.test(msg)) {
				throw new Error('当前打开的是已翻译的双语 PDF，BabelDOC 拒绝二次翻译。'
					+ '请打开原始英文 PDF，或在文献列表右键用「用引擎生成双语 PDF（后台队列）」。');
			}
			throw new Error('引擎报错：' + msg.slice(0, 500));
		}
		if (exitCode !== 0) throw new Error('引擎退出码 ' + exitCode + '（无结构化错误）：' + tail.slice(-400));

		// 优先用 finish 事件给出的路径，其次扫描输出目录
		let produced = null;
		if (ev.finish) {
			for (let cand of [ev.finish.dual, ev.finish.mono]) {
				if (!cand) continue;
				try {
					if (await IOUtils.exists(cand)) { produced = cand; break; }
				}
				catch (e) { /* ignore */ }
			}
		}
		if (!produced) produced = await this._pickOutput(outDir, pdfPath);
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