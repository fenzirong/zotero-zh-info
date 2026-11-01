/* PDF 双语对照阅读视图
 * 打开后在阅读器内以重排文本方式逐段显示原文 + 中文译文，每段右侧可单独取消。
 * 文本来源：优先 pdf.js 文本层（有坐标，可正确切段落），失败则回退 Zotero.PDFWorker.getFullText。
 */

if (typeof Zotero == 'undefined') {
	var Zotero;
}

var ZHInfoBilingual;

ZHInfoBilingual = {
	pluginID: null,
	_states: null,
	_toolbarDocs: null,

	init({ pluginID }) {
		this.pluginID = pluginID;
		this._states = new Map();
		this._toolbarDocs = new WeakSet();
		this._onToolbar = (event) => this._handleToolbar(event);
		try {
			Zotero.Reader.registerEventListener('renderToolbar', this._onToolbar, pluginID);
			Zotero.debug('ZhInfo: bilingual toolbar listener registered');
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	shutdown() {
		try {
			if (this._onToolbar) Zotero.Reader.unregisterEventListener('renderToolbar', this._onToolbar);
		}
		catch (e) {
			Zotero.logError(e);
		}
		this._onToolbar = null;
		if (this._states) {
			for (let state of this._states.values()) {
				this._closeView(state, true);
			}
		}
		this._states = null;
	},

	// ------------------------------------------------------------ prefs

	_pref(key, dflt) {
		try {
			const v = Zotero.Prefs.get('extensions.zhinfo.' + key, true);
			if (v === undefined || v === null || v === '') return dflt;
			return v;
		}
		catch (e) {
			return dflt;
		}
	},

	_sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	},

	// ------------------------------------------------------------ toolbar

	_handleToolbar({ reader, doc, append }) {
		try {
			if (!doc || !reader) return;
			this._injectStyle(doc);
			let btn = doc.getElementById('zhb-toolbar-btn');
			if (!btn) {
				btn = doc.createElement('button');
				btn.id = 'zhb-toolbar-btn';
				btn.type = 'button';
				btn.className = 'zhb-toolbar-btn';
				btn.title = '中文双语对照（逐段翻译，可单段取消）';
				btn.textContent = '双语对照';
				btn.addEventListener('click', (event) => {
					event.preventDefault();
					event.stopPropagation();
					try {
						this.toggle(reader);
					}
					catch (e) {
						Zotero.logError(e);
					}
				});
				append(btn);
			}
			if (this._pref('pdfAuto', false)) {
				setTimeout(() => {
					try {
						this.open(reader);
					}
					catch (e) {
						Zotero.logError(e);
					}
				}, 1200);
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// ------------------------------------------------------------ 开关

	toggle(reader) {
		const id = reader.itemID;
		const state = this._states.get(id);
		if (state && state.root) {
			this._closeView(state, false);
			return;
		}
		this.open(reader);
	},

	async open(reader) {
		try {
			const id = reader.itemID;
			if (!id) return;
			let state = this._states.get(id);
			if (!state) {
				state = {
					attachmentID: id,
					reader,
					blocks: null,
					root: null,
					list: null,
					headerEls: {},
					running: false,
					aborted: false,
					extracting: false,
				};
				this._states.set(id, state);
			}
			if (state.root) return;

			this._buildView(state);

			if (!state.blocks) {
				state.extracting = true;
				this._setStatus(state, '正在提取文本…');
				const scope = this._pref('pdfScope', 'page');
				const blocks = await this.extract(state.reader, scope);
				state.extracting = false;
				if (!blocks.length) {
					this._setStatus(state, '未能提取到文本（可能是扫描版 PDF）');
					return;
				}
				state.blocks = blocks;
				this._renderList(state);
			}
			else {
				this._renderList(state);
			}
			this._setStatus(state, '共 ' + state.blocks.length + ' 段');
			this.run(state);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// ------------------------------------------------------------ 提取

	async extract(reader, scope) {
		let app = null;
		try {
			const W = reader._iframeWindow && reader._iframeWindow.wrappedJSObject;
			app = W && W.PDFViewerApplication;
		}
		catch (e) {
			Zotero.logError(e);
		}
		if (app && app.pdfDocument) {
			try {
				const blocks = await this._extractFromPdfJs(app, scope);
				if (blocks.length) return blocks;
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		return await this._extractFromWorker(reader, scope);
	},

	async _extractFromPdfJs(app, scope) {
		const total = app.pagesCount || (app.pdfDocument && app.pdfDocument.numPages) || 0;
		if (!total) return [];
		let pages;
		if (scope === 'page') {
			let cur = 1;
			try {
				cur = app.page || (app.pdfViewer && app.pdfViewer.currentPageNumber) || 1;
			}
			catch (e) { /* ignore */ }
			pages = [Math.max(1, Math.min(total, cur))];
		}
		else {
			pages = [];
			for (let i = 1; i <= total; i++) pages.push(i);
		}

		const minChars = Number(this._pref('pdfMinChars', 20)) || 20;
		let all = [];
		for (let pageNo of pages) {
			let page;
			try {
				page = await app.pdfDocument.getPage(pageNo);
			}
			catch (e) {
				continue;
			}
			const raw = page.wrappedJSObject || page;
			let tc;
			try {
				tc = await raw.getTextContent();
			}
			catch (e) {
				continue;
			}
			let width = 600;
			let height = 800;
			try {
				const vp = raw.getViewport({ scale: 1 });
				width = vp.width;
				height = vp.height;
			}
			catch (e) { /* ignore */ }

			const items = [];
			const list = (tc && tc.items) || [];
			for (let i = 0; i < list.length; i++) {
				const it = list[i];
				const s = String(it.str == null ? '' : it.str);
				if (!s.trim()) continue;
				const tr = it.transform || [1, 0, 0, 1, 0, 0];
				const angle = Math.atan2(tr[1], tr[0]);
				if (Math.abs(angle) > 0.06) continue;
				if (s.trim().length <= 2 && (tr[4] < width * 0.05 || tr[4] > width * 0.95)) continue;
				const scale = Math.sqrt(tr[0] * tr[0] + tr[1] * tr[1]) || 10;
				items.push({
					s,
					x: tr[4],
					y: tr[5],
					w: it.width || 0,
					h: it.height || scale,
				});
			}
			const paras = this._itemsToParagraphs(items, width, height);
			for (let p of paras) {
				if (p.length >= minChars) all.push({ page: pageNo, src: p });
			}
		}
		return all.map((b, i) => ({ idx: i, page: b.page, src: b.src, dst: '', status: 'idle', err: '' }));
	},

	async _extractFromWorker(reader, scope) {
		const minChars = Number(this._pref('pdfMinChars', 20)) || 20;
		let text = '';
		try {
			const full = await Zotero.PDFWorker.getFullText(reader.itemID, scope === 'page' ? 1 : null, true);
			text = (full && full.text) || '';
		}
		catch (e) {
			Zotero.logError(e);
			return [];
		}
		if (!text) return [];
		const pages = text.split('\f');
		const out = [];
		let idx = 0;
		for (let pi = 0; pi < pages.length; pi++) {
			const paras = this._linesToParagraphs(String(pages[pi] || '').split('\n'));
			for (let p of paras) {
				if (p.length >= minChars) {
					out.push({ idx: idx++, page: pi + 1, src: p, dst: '', status: 'idle', err: '' });
				}
			}
		}
		return out;
	},

	// ------------------------------------------------------------ 文本 → 段落

	_itemsToParagraphs(items, pageWidth, pageHeight) {
		if (!items.length) return [];
		const cols = this._splitColumns(items, pageWidth);
		if (cols) {
			let out = [];
			for (let col of cols) {
				out = out.concat(this._columnToParagraphs(col, pageWidth, pageHeight));
			}
			return out;
		}
		return this._columnToParagraphs(items, pageWidth, pageHeight);
	},

	/** 用中部的空白带判断是否双栏；是则返回 [左栏 items, 右栏 items]，否则 null */
	_splitColumns(items, pageWidth) {
		if (!items.length || !pageWidth) return null;
		const bins = 24;
		const hist = [];
		for (let b = 0; b < bins; b++) hist.push(0);
		for (let it of items) {
			let b = Math.floor((it.x / pageWidth) * bins);
			if (b < 0) b = 0;
			if (b >= bins) b = bins - 1;
			hist[b]++;
		}
		let gut = -1;
		const from = Math.floor(bins * 0.36);
		const to = Math.ceil(bins * 0.64);
		for (let b = from; b < to; b++) {
			if (hist[b] === 0) { gut = b; break; }
		}
		if (gut < 0) return null;
		const cut = (gut / bins) * pageWidth;
		const left = [];
		const right = [];
		for (let it of items) {
			const center = it.x + (it.w || 0) / 2;
			if (center < cut) left.push(it);
			else right.push(it);
		}
		const minSide = items.length * 0.2;
		if (left.length < minSide || right.length < minSide) return null;
		return [left, right];
	},

	/** 单栏 / 单列内：行归并 + 段落切分 */
	_columnToParagraphs(items, pageWidth, pageHeight) {
		if (!items.length) return [];
		const sorted = items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));

		// 1) 聚成行
		const lines = [];
		let cur = null;
		for (let it of sorted) {
			if (!cur || Math.abs(it.y - cur.y) > Math.max(2, (it.h || 10) * 0.5)) {
				cur = { y: it.y, h: it.h || 10, items: [it] };
				lines.push(cur);
			}
			else {
				cur.items.push(it);
			}
		}

		// 2) 行内拼接
		const lineObjs = lines.map((ln) => {
			const arr = ln.items.slice().sort((a, b) => a.x - b.x);
			let text = '';
			let prev = null;
			for (let it of arr) {
				if (prev) {
					const gap = it.x - (prev.x + (prev.w || 0));
					if (gap > 1.2 && !/\s$/.test(text) && !/^\s/.test(it.s)) text += ' ';
				}
				text += it.s;
				prev = it;
			}
			return {
				text: text.replace(/\s+/g, ' ').trim(),
				x0: arr[0].x,
				x1: arr[arr.length - 1].x + (arr[arr.length - 1].w || 0),
				y: ln.y,
				h: ln.h,
			};
		}).filter((l) => l.text);

		if (!lineObjs.length) return [];

		// 3) 页眉页脚剔除（位置只作辅助，必须同时“短且无句末标点”）
		const cleaned = lineObjs.filter((l) => {
			if (l.text.length < 3) return false;
			if (/^(page\s*)?\d+(\s*\/\s*\d+)?$/i.test(l.text)) return false;
			const nearEdge = (l.y > pageHeight * 0.94) || (l.y < pageHeight * 0.06);
			const noEndPunct = !/[.!?:;。！？：；]$/.test(l.text);
			if (nearEdge && l.text.length < 70 && noEndPunct) return false;
			if (l.text.length < 90 && /(doi:|issn|received|accepted|published|copyright|www\.|@|\bvol\.?\s*\d)/i.test(l.text)) return false;
			if (l.text.length < 120 && /et al\.?,?\s+[A-Za-z ]{2,20}\s*\d{4}/.test(l.text)) return false;
			return true;
		});
		if (!cleaned.length) return [];

		// 4) 行 → 段（按自上而下）
		const ordered = cleaned.slice().sort((a, b) => b.y - a.y);
		const heights = ordered.map((l) => l.h).sort((a, b) => a - b);
		const medH = heights[Math.floor(heights.length / 2)] || 10;
		const colLeft = Math.min.apply(null, ordered.map((l) => l.x0));
		const colRight = Math.max.apply(null, ordered.map((l) => l.x1));
		const colWidth = Math.max(1, colRight - colLeft);
		const gapThreshold = medH * 1.45;

		const paras = [];
		let buf = '';
		let prev = null;
		for (let l of ordered) {
			const dgap = prev ? (prev.y - l.y) : 0;
			const indented = prev ? ((l.x0 - prev.x0) > Math.max(6, medH * 0.6)) : false;
			const prevEndsShort = prev ? ((prev.x1 - colLeft) < colWidth * 0.72) : false;
			const prevEndsSentence = prev ? /[.!?:。！？：]$/.test(prev.text) : false;
			const sizeChanged = prev
				? (Math.abs((l.h || 0) - (prev.h || 0)) > Math.max(1.5, (prev.h || 10) * 0.3))
				: false;
			const newPara = !!prev && (
				dgap > gapThreshold
				|| indented
				|| sizeChanged
				|| (prevEndsSentence && prevEndsShort && dgap > medH * 0.2)
				|| (buf.length + l.text.length > 900)
			);
			if (newPara && buf.trim()) {
				paras.push(this._cleanPara(buf));
				buf = '';
			}
			buf = this._appendLine(buf, l.text);
			prev = l;
		}
		if (buf.trim()) paras.push(this._cleanPara(buf));
		return paras.filter((p) => p && p.length > 0);
	},
	_linesToParagraphs(lines) {
		const out = [];
		let buf = '';
		let prevLen = 0;
		for (let raw of lines) {
			let line = String(raw || '').replace(/\s+/g, ' ').trim();
			if (!line) {
				if (buf.trim()) { out.push(this._cleanPara(buf)); buf = ''; }
				continue;
			}
			if (/^(page\s*)?\d+(\s*\/\s*\d+)?$/i.test(line)) continue;
			if (line.length < 90 && /(doi:|issn|received|accepted|published|copyright|www\.|@|\bvol\.?\s*\d)/i.test(line)) continue;
			buf = this._appendLine(buf, line);
			prevLen = line.length;
			const endsSentence = /[.!?:。！？：]$/.test(line);
			if (endsSentence && prevLen < 65 && buf.length > 120) {
				out.push(this._cleanPara(buf));
				buf = '';
			}
			else if (buf.length > 900) {
				out.push(this._cleanPara(buf));
				buf = '';
			}
		}
		if (buf.trim()) out.push(this._cleanPara(buf));
		return out.filter((p) => p && p.length > 0);
	},

	/** 拼接行：行尾连字符时去连字符并直接相连 */
	_appendLine(buf, line) {
		if (!buf) return line;
		if (/[A-Za-z]-$/.test(buf)) return buf.slice(0, -1) + line;
		return buf + ' ' + line;
	},

	_cleanPara(s) {
		return String(s || '')
			.replace(/\s+/g, ' ')
			.replace(/\s+([,.;:!?])/g, '$1')
			.trim();
	},

	// ------------------------------------------------------------ 翻译

	async run(state) {
		if (!state || !state.blocks || state.running) return;
		state.running = true;
		state.aborted = false;
		this._updateHeader(state);

		let fails = 0;
		for (let b of state.blocks) {
			if (state.aborted) break;
			if (b.status === 'done' || b.status === 'skipped') continue;
			await this._translateBlock(state, b);
			fails = (b.status === 'error') ? fails + 1 : 0;
			if (fails >= 3) {
				this._setStatus(state, '连续失败 3 次，已暂停（检查设置里的翻译服务）');
				break;
			}
			await this._sleep(250);
		}
		state.running = false;
		this._updateHeader(state);
	},

	async _translateBlock(state, b) {
		if (b.status === 'skipped') return;
		b.status = 'loading';
		b.err = '';
		this._renderBlock(state, b);
		try {
			const out = await ZHInfoTranslate.translate(b.src, 'text');
			if (b.status === 'skipped') return;
			b.dst = out;
			b.status = 'done';
		}
		catch (e) {
			if (b.status === 'skipped') return;
			b.err = (e && e.message) ? e.message : String(e);
			b.status = 'error';
			Zotero.logError(e);
		}
		this._renderBlock(state, b);
		this._updateHeader(state);
	},

	stop(state) {
		state.aborted = true;
		this._setStatus(state, '已停止');
		this._updateHeader(state);
	},

	clear(state) {
		if (!state || !state.blocks) return;
		for (let b of state.blocks) {
			b.dst = '';
			b.err = '';
			b.status = 'idle';
		}
		this._renderList(state);
		this._setStatus(state, '已清除译文');
		this._updateHeader(state);
	},

	skipBlock(state, b) {
		b.status = 'skipped';
		b.dst = '';
		b.err = '';
		this._renderBlock(state, b);
		this._updateHeader(state);
	},

	// ------------------------------------------------------------ 视图

	_injectStyle(doc) {
		try {
			if (!doc || !doc.head || this._toolbarDocs.has(doc)) return;
			const style = doc.createElement('style');
			style.textContent = [
				'.zhb-toolbar-btn { font: inherit; font-size: 12px; padding: 2px 8px; margin: 0 4px; border-radius: 4px;'
					+ ' border: 1px solid rgba(127,127,127,.5); background: transparent; color: inherit; cursor: pointer; }',
				'.zhb-toolbar-btn:hover { background: rgba(127,127,127,.2); }',
				'.zhb-overlay { position: fixed; inset: 0; z-index: 2147483000; overflow: auto; padding: 0;'
					+ ' background: var(--material-background, #fff); color: inherit; font-size: 15px; }',
				'.zhb-bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px;'
					+ ' padding: 10px 16px; border-bottom: 1px solid rgba(127,127,127,.35);'
					+ ' background: var(--material-background, #fff); flex-wrap: wrap; }',
				'.zhb-title { font-weight: 600; }',
				'.zhb-status { font-size: 12px; opacity: .75; }',
				'.zhb-btn { font: inherit; font-size: 12px; padding: 2px 10px; border-radius: 4px; cursor: pointer;'
					+ ' border: 1px solid rgba(127,127,127,.5); background: transparent; color: inherit; }',
				'.zhb-btn:hover { background: rgba(127,127,127,.18); }',
				'.zhb-body { max-width: 820px; margin: 0 auto; padding: 20px 28px 120px; line-height: 1.85; }',
				'.zhb-block { position: relative; padding: 10px 34px 14px 0; border-bottom: 1px dashed rgba(127,127,127,.3); }',
				'.zhb-src { opacity: .62; font-size: 13px; }',
				'.zhb-dst { margin-top: 6px; white-space: pre-wrap; }',
				'.zhb-dst[data-status="idle"]::after { content: "（未翻译）"; opacity: .45; font-size: 12px; }',
				'.zhb-dst[data-status="loading"]::after { content: "翻译中…"; opacity: .6; font-size: 12px; }',
				'.zhb-dst[data-status="error"] { color: #d92b2b; font-size: 13px; }',
				'.zhb-dst[data-status="skipped"] { opacity: .4; font-size: 13px; font-style: italic; }',
				'.zhb-x { position: absolute; top: 8px; right: 0; width: 24px; height: 24px; line-height: 20px;'
					+ ' border-radius: 50%; border: 1px solid rgba(127,127,127,.5); background: transparent;'
					+ ' color: inherit; cursor: pointer; font-size: 13px; padding: 0; }',
				'.zhb-x:hover { background: rgba(217,43,43,.15); border-color: #d92b2b; }',
				'.zhb-page { font-size: 12px; opacity: .5; margin: 18px 0 4px; }',
			].join('\n');
			doc.head.appendChild(style);
			this._toolbarDocs.add(doc);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	_buildView(state) {
		const reader = state.reader;
		const doc = reader._iframeWindow && reader._iframeWindow.document;
		if (!doc) throw new Error('无法访问阅读器文档');
		this._injectStyle(doc);
		const old = doc.getElementById('zhb-overlay');
		if (old) old.remove();

		const root = doc.createElement('div');
		root.id = 'zhb-overlay';
		root.className = 'zhb-overlay';

		const bar = doc.createElement('div');
		bar.className = 'zhb-bar';

		const title = doc.createElement('span');
		title.className = 'zhb-title';
		title.textContent = '双语对照';

		const status = doc.createElement('span');
		status.className = 'zhb-status';
		status.textContent = '';

		const btnRun = doc.createElement('button');
		btnRun.type = 'button';
		btnRun.className = 'zhb-btn';
		btnRun.textContent = '继续翻译';
		btnRun.addEventListener('click', () => this.run(state));

		const btnStop = doc.createElement('button');
		btnStop.type = 'button';
		btnStop.className = 'zhb-btn';
		btnStop.textContent = '停止';
		btnStop.addEventListener('click', () => this.stop(state));

		const btnClear = doc.createElement('button');
		btnClear.type = 'button';
		btnClear.className = 'zhb-btn';
		btnClear.textContent = '清除译文';
		btnClear.addEventListener('click', () => this.clear(state));

		const btnClose = doc.createElement('button');
		btnClose.type = 'button';
		btnClose.className = 'zhb-btn';
		btnClose.textContent = '关闭';
		btnClose.addEventListener('click', () => this._closeView(state, false));

		let providerName = '';
		try {
			providerName = ZHInfoTranslate.providerName();
		}
		catch (e) { /* ignore */ }

		const provider = doc.createElement('span');
		provider.className = 'zhb-status';
		provider.textContent = '服务：' + providerName;

		bar.appendChild(title);
		bar.appendChild(status);
		bar.appendChild(btnRun);
		bar.appendChild(btnStop);
		bar.appendChild(btnClear);
		bar.appendChild(btnClose);
		bar.appendChild(provider);

		const body = doc.createElement('div');
		body.className = 'zhb-body';

		root.appendChild(bar);
		root.appendChild(body);
		doc.documentElement.appendChild(root);

		state.root = root;
		state.list = body;
		state.headerEls = { status, btnRun, btnStop };
	},

	_setStatus(state, text) {
		try {
			if (state && state.headerEls && state.headerEls.status) state.headerEls.status.textContent = text;
		}
		catch (e) { /* ignore */ }
	},

	_updateHeader(state) {
		try {
			if (!state || !state.blocks) return;
			const total = state.blocks.length;
			let done = 0;
			let skip = 0;
			for (let b of state.blocks) {
				if (b.status === 'done') done++;
				if (b.status === 'skipped') skip++;
			}
			this._setStatus(state, done + '/' + total + (skip ? '（跳过 ' + skip + '）' : '') + (state.running ? ' · 翻译中' : ''));
			if (state.headerEls && state.headerEls.btnRun) state.headerEls.btnRun.disabled = state.running;
		}
		catch (e) { /* ignore */ }
	},

	_renderList(state) {
		const doc = state.root && state.root.ownerDocument;
		if (!doc || !state.list) return;
		state.list.textContent = '';
		let lastPage = null;
		for (let b of state.blocks) {
			if (b.page && b.page !== lastPage) {
				lastPage = b.page;
				const ph = doc.createElement('div');
				ph.className = 'zhb-page';
				ph.textContent = '第 ' + b.page + ' 页';
				state.list.appendChild(ph);
			}
			state.list.appendChild(this._blockElement(state, b));
		}
		this._updateHeader(state);
	},

	_blockElement(state, b) {
		const doc = state.root.ownerDocument;
		if (b.el) return b.el;
		const block = doc.createElement('div');
		block.className = 'zhb-block';

		const src = doc.createElement('div');
		src.className = 'zhb-src';
		src.textContent = b.src;

		const dst = doc.createElement('div');
		dst.className = 'zhb-dst';

		const x = doc.createElement('button');
		x.type = 'button';
		x.className = 'zhb-x';
		x.title = '取消该段翻译';
		x.textContent = '×';
		x.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.skipBlock(state, b);
		});

		block.appendChild(x);
		block.appendChild(src);
		block.appendChild(dst);
		b.el = block;
		b.dstEl = dst;
		this._paintBlock(b);
		return block;
	},

	_paintBlock(b) {
		if (!b.dstEl) return;
		const status = b.status || 'idle';
		if (status === 'done') b.dstEl.textContent = b.dst;
		else if (status === 'error') b.dstEl.textContent = '翻译失败：' + (b.err || '');
		else if (status === 'skipped') b.dstEl.textContent = '（已取消该段）';
		else b.dstEl.textContent = '';
		b.dstEl.dataset.status = status;
	},

	_renderBlock(state, b) {
		try {
			this._paintBlock(b);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	_closeView(state, immediate) {
		try {
			state.aborted = true;
			const root = state.root;
			const doc = root && root.ownerDocument;
			if (root && root.parentNode) root.remove();
			state.root = null;
			state.list = null;
			state.headerEls = {};
			if (immediate && doc) {
				const btn = doc.getElementById('zhb-toolbar-btn');
				if (btn) btn.remove();
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	},
};