/* PDF 双语：保留原版面（原位覆盖）+ 可选重排阅读视图
 * inline 模式：译文精确覆盖在原段落矩形内（字号自适应），图片/表格/分栏等版式不动；
 *              每段右上角 × 取消该段（恢复原文），顶栏可切换显示原文/译文、停止、清除。
 * reflow 模式：抽取文字重排成阅读视图（原文 + 段下译文）。
 */

if (typeof Zotero == 'undefined') {
	var Zotero;
}

var ZHInfoBilingual;

ZHInfoBilingual = {
	pluginID: null,
	_states: null,
	_docs: null,

	init({ pluginID }) {
		this.pluginID = pluginID;
		this._states = new Map();
		this._docs = new WeakSet();
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

	// ------------------------------------------------------------ prefs / utils

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
				btn.title = '中文双语（保留原版面，逐段覆盖译文）';
				btn.textContent = '双语';
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
		const state = this._states.get(reader.itemID);
		if (state && state.active) {
			this._closeView(state, false);
			return;
		}
		this.open(reader);
	},

	_modeFor(state) {
		const mode = String(this._pref('pdfMode', 'inline'));
		if (mode === 'reflow') return 'reflow';
		const hasRect = state.blocks && state.blocks.some(b => b.rect);
		if (!hasRect) return 'reflow';
		if (!this._rotationOK(state)) return 'reflow';
		return 'inline';
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
					active: false,
					mode: null,
					running: false,
					aborted: false,
					showOriginal: false,
					lastScale: 0,
					lastPageCount: 0,
					lastPageNo: 0,
					watcher: null,
					bar: null,
					barEls: {},
					root: null,
					list: null,
					startPage: 1,
					limit: 1,
					follow: true,
				};
				this._states.set(id, state);
			}
			if (state.active) return;
			state.active = true;

			state.startPage = this._currentPage(state) || 1;
			state.limit = this._limitValue(state);
			state.follow = this._pref('pdfFollow', true) !== false;

			if (!state.blocks) {
				this._setStatus(state, '正在提取文本…');
				state.blocks = await this.extract(reader, 'all');
				if (!state.blocks.length) {
					this._setStatus(state, '未能提取到文本（可能是扫描版 PDF）');
					state.active = false;
					return;
				}
			}

			state.mode = this._modeFor(state);
			if (state.mode === 'inline') {
				this._buildBar(state);
				this._renderInline(state);
				this._watchView(state);
			}
			else {
				this._buildView(state);
				this._renderList(state);
			}
			this._updateHeader(state);
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
			let curPage = 1;
			try {
				curPage = app.page || (app.pdfViewer && app.pdfViewer.currentPageNumber) || 1;
			}
			catch (e) { /* ignore */ }
			pages = [Math.max(1, Math.min(total, curPage))];
		}
		else {
			pages = [];
			for (let i = 1; i <= total; i++) pages.push(i);
		}

		const minChars = Number(this._pref('pdfMinChars', 20)) || 20;
		let all = [];
		let idx = 0;
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
				if (p.text.length >= minChars) {
					all.push({
						idx: idx++,
						page: pageNo,
						src: p.text,
						rect: p.rect,
						lines: p.lines,
						avgH: p.avgH,
						pageW: width,
						pageH: height,
						dst: '',
						status: 'idle',
						err: '',
					});
				}
			}
		}
		return all;
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
					out.push({ idx: idx++, page: pi + 1, src: p, rect: null, lines: 0, avgH: 0, dst: '', status: 'idle', err: '' });
				}
			}
		}
		return out;
	},
	// ------------------------------------------------------------ 文本 → 段落（保留几何信息）

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

	_columnToParagraphs(items, pageWidth, pageHeight) {
		if (!items.length) return [];
		const sorted = items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));

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

		const ordered = cleaned.slice().sort((a, b) => b.y - a.y);
		const heights = ordered.map((l) => l.h).sort((a, b) => a - b);
		const medH = heights[Math.floor(heights.length / 2)] || 10;
		const colLeft = Math.min.apply(null, ordered.map((l) => l.x0));
		const colRight = Math.max.apply(null, ordered.map((l) => l.x1));
		const colWidth = Math.max(1, colRight - colLeft);
		const gapThreshold = medH * 1.45;

		const out = [];
		let curPara = null;
		let prev = null;
		const flush = () => {
			if (!curPara) return;
			const text = this._cleanPara(curPara.text);
			if (text) {
				out.push({
					text,
					rect: { x0: curPara.x0, x1: curPara.x1, y0: curPara.yBottom, y1: curPara.yTop },
					lines: curPara.n,
					avgH: curPara.hSum / Math.max(1, curPara.n),
				});
			}
			curPara = null;
		};

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
				|| ((curPara ? curPara.text.length : 0) + l.text.length > 900)
			);
			if (newPara) flush();
			if (!curPara) {
				curPara = {
					text: '',
					x0: l.x0,
					x1: l.x1,
					yTop: l.y + (l.h || medH) * 0.82,
					yBottom: l.y - (l.h || medH) * 0.95,
					n: 0,
					hSum: 0,
				};
			}
			curPara.text = this._appendLine(curPara.text, l.text);
			curPara.x0 = Math.min(curPara.x0, l.x0);
			curPara.x1 = Math.max(curPara.x1, l.x1);
			curPara.yBottom = Math.min(curPara.yBottom, l.y - (l.h || medH) * 0.95);
			curPara.n++;
			curPara.hSum += (l.h || medH);
			prev = l;
		}
		flush();
		return out;
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
		try {
			while (!state.aborted) {
				const page = this._nextPage(state);
				if (page == null) {
					if (!state.follow) break;
					if (this._beyondLimit(state)) {
						this._setStatus(state, '已到设定页数上限（' + this._limitLabel(state) + '）');
						break;
					}
					await this._sleep(800);
					continue;
				}

				const todo = state.blocks.filter(b => b.page === page && b.status === 'idle');
				for (let b of todo) {
					if (state.aborted) break;
					if (b.status !== 'idle') continue;
					await this._translateBlock(state, b);
					fails = (b.status === 'error') ? fails + 1 : 0;
					if (fails >= 3) {
						this._setStatus(state, '连续失败 3 次，已暂停（检查翻译服务设置）');
						state.aborted = true;
						break;
					}
					await this._sleep(200);
				}
			}
		}
		finally {
			state.running = false;
			this._updateHeader(state);
		}
	},

	async _translateBlock(state, b) {
		if (b.status === 'skipped') return;
		b.status = 'loading';
		b.err = '';
		try {
			let timer = null;
			const timeout = new Promise((resolve, reject) => {
				timer = setTimeout(() => reject(new Error('翻译超时（45 秒无响应）')), 45000);
			});
			let out;
			try {
				out = await Promise.race([ZHInfoTranslate.translate(b.src, 'text'), timeout]);
			}
			finally {
				if (timer) clearTimeout(timer);
			}
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
		this._repaintBlock(state, b);
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
		if (state.mode === 'inline') this._renderInline(state);
		else this._renderList(state);
		this._setStatus(state, '已清除译文');
		this._updateHeader(state);
	},

	skipBlock(state, b) {
		b.status = 'skipped';
		b.dst = '';
		b.err = '';
		this._repaintBlock(state, b);
		this._updateHeader(state);
	},

	_repaintBlock(state, b) {
		try {
			if (state.mode !== 'inline') {
				this._paintBlock(b);
				return;
			}
			const views = this._pageViews(state);
			for (let v of views) {
				if (v.pageNo === b.page) this._renderInlinePage(state, v.div, v.pageNo);
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// ------------------------------------------------------------ inline 视图（保留原版面）

	_iframeWin(state) {
		try {
			return state.reader._iframeWindow;
		}
		catch (e) {
			return null;
		}
	},

	_scale(state) {
		try {
			const W = this._iframeWin(state).wrappedJSObject;
			const s = W.PDFViewerApplication.pdfViewer.currentScale;
			return s || 1;
		}
		catch (e) {
			return 1;
		}
	},

	_viewerApp(state) {
		try {
			const W = this._iframeWin(state).wrappedJSObject;
			return W && W.PDFViewerApplication;
		}
		catch (e) {
			return null;
		}
	},

	/** 页面节点列表：[{ pageNo, div }]（只取 pdf.js 已创建的页面视图） */
	_pageViews(state) {
		const out = [];
		try {
			const app = this._viewerApp(state);
			if (!app || !app.pdfViewer) return out;
			const n = app.pagesCount || 0;
			for (let i = 0; i < n; i++) {
				let pv = null;
				try {
					pv = app.pdfViewer.getPageView(i);
				}
				catch (e) { /* ignore */ }
				if (pv && pv.div) out.push({ pageNo: i + 1, div: pv.div });
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		return out;
	},

	/** 页面实际所在的文档（可能与 reader._iframeWindow.document 不同） */
	_viewerDoc(state) {
		try {
			const views = this._pageViews(state);
			for (let v of views) {
				if (v.div && v.div.ownerDocument) return v.div.ownerDocument;
			}
		}
		catch (e) { /* ignore */ }
		try {
			return this._iframeWin(state).document;
		}
		catch (e) {
			return null;
		}
	},

	_pageCount(state) {
		return this._pageViews(state).length;
	},

	_watchView(state) {
		if (state.watcher) clearInterval(state.watcher);
		state.lastScale = this._scale(state);
		state.lastPageCount = this._pageCount(state);
		state.lastPageNo = this._currentPage(state);
		state.watcher = setInterval(() => {
			try {
				if (!state.active) return;
				const s = this._scale(state);
				const n = this._pageCount(state);
				const p = this._currentPage(state);
				if (s !== state.lastScale) {
					state.lastScale = s;
					this._renderInline(state);
				}
				if (n !== state.lastPageCount) {
					state.lastPageCount = n;
					this._renderInline(state);
				}
				const pageChanged = (p !== state.lastPageNo);
				if (pageChanged) {
					state.lastPageNo = p;
					this._updateHeader(state);
				}
				if (state.follow && !state.aborted && !state.running && this._nextPage(state) != null) {
					this.run(state);
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
		}, 500);
	},

	_renderInline(state) {
		// 结构变化（缩放 / 页面变化 / 清除 / 切显示）时整体重排
		try {
			if (!state.pages) state.pages = new Map();
			for (let gp of state.pages.values()) {
				gp.layer.textContent = '';
				gp.els.clear();
			}
			const views = this._pageViews(state);
			for (let v of views) {
				const hasDone = state.blocks.some(b => b.page === v.pageNo && b.status === 'done' && b.rect);
				const existing = state.pages.get(v.pageNo);
				if (!hasDone) {
					if (existing) existing.layer.style.display = 'none';
					continue;
				}
				const gp = this._ensurePage(state, v.pageNo, v.div);
				gp.layer.style.display = state.showOriginal ? 'none' : '';
				for (let b of state.blocks) {
					if (b.page !== v.pageNo) continue;
					this._syncBlock(state, b);
				}
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	/** 页面容器（layer + 元素表）懒创建 */
	_ensurePage(state, pageNo, pageDiv) {
		if (!state.pages) state.pages = new Map();
		let gp = state.pages.get(pageNo);
		if (gp) return gp;
		const doc = pageDiv.ownerDocument;
		let layer = pageDiv.querySelector('.zhb-inline-layer');
		if (!layer) {
			layer = doc.createElement('div');
			layer.className = 'zhb-inline-layer';
			pageDiv.appendChild(layer);
		}
		gp = { pageDiv, layer, els: new Map() };
		state.pages.set(pageNo, gp);
		return gp;
	},

	/** 单块增量同步：只新增/更新/移除这一块的元素，不重建整页 */
	_syncBlock(state, b) {
		const gp = state.pages && state.pages.get(b.page);
		if (!gp) return;
		const want = (b.status === 'done' && b.dst && b.rect);
		let el = gp.els.get(b.idx);
		if (!want) {
			if (el) {
				el.remove();
				gp.els.delete(b.idx);
			}
			return;
		}
		if (!el) {
			el = this._makeEl(state, b, gp);
			if (!el) return;
			gp.layer.appendChild(el);
			gp.els.set(b.idx, el);
			this._fitEl(el);
			return;
		}
		if (el._dst !== b.dst) {
			el._dst = b.dst;
			el._txtEl.textContent = b.dst;
			this._fitEl(el);
		}
	},

	/** 该块下方到下一块之间的空白（PDF 点），可用作译文的额外高度 */
	/** 该页行高中位数（PDF 点），作为译文字号基准，避免逐块抖动 */
	_pageMedianH(state, pageNo) {
		const hs = [];
		for (let b of (state.blocks || [])) {
			if (b.page === pageNo && b.avgH) hs.push(b.avgH);
		}
		if (!hs.length) return 0;
		hs.sort((a, b) => a - b);
		return hs[Math.floor(hs.length / 2)];
	},

	_gapBelow(state, b) {
		let best = null;
		for (let o of state.blocks) {
			if (o === b || o.page !== b.page || !o.rect) continue;
			if (o.rect.y1 < b.rect.y0) {
				if (best == null || o.rect.y1 > best) best = o.rect.y1;
			}
		}
		if (best == null) return 0;
		const gap = Math.max(0, b.rect.y0 - best);
		const ownH = Math.max(1, b.rect.y1 - b.rect.y0);
		return Math.min(gap, ownH * 1.5);
	},

	_makeEl(state, b, gp) {
		const doc = gp.pageDiv.ownerDocument;
		const scale = this._scale(state);
		let pageH = 0;
		try {
			pageH = gp.pageDiv.getBoundingClientRect().height || gp.pageDiv.clientHeight || 0;
		}
		catch (e) { /* ignore */ }
		if (!pageH) return null;

		const widthPt = b.rect.x1 - b.rect.x0;
		const heightPt = b.rect.y1 - b.rect.y0;
		if (widthPt * scale < 24 || heightPt * scale < 7) return null;

		const gapPt = this._gapBelow(state, b);
		const left = Math.max(0, b.rect.x0 * scale - 1);
		const top = Math.max(0, pageH - b.rect.y1 * scale - 1);
		const width = Math.max(16, widthPt * scale + 3);
		const ownH = Math.max(9, heightPt * scale);
		const availH = ownH + Math.max(0, gapPt * scale);
		const medH = this._pageMedianH(state, b.page);
		const refH = Math.min(b.avgH || medH || 10, (medH || 10) * 1.35);
		const baseFs = Math.max(5, Math.min(42, (refH || 10) * 1.02 * scale));

		const el = doc.createElement('div');
		el.className = 'zhb-inline';
		el.dataset.idx = String(b.idx);
		el.style.left = left + 'px';
		el.style.top = top + 'px';
		el.style.width = width + 'px';
		el.style.minHeight = ownH + 'px';
		el.style.maxHeight = availH + 'px';
		el.style.fontSize = baseFs + 'px';
		try {
			const NL = String.fromCharCode(10);
			el.title = (b.src || '') + (b.dst ? (NL + NL + '——' + NL + NL + b.dst) : '');
		}
		catch (e) { /* ignore */ }

		const txt = doc.createElement('div');
		txt.className = 'zhb-inline-text';
		txt.textContent = b.dst || '';
		el.appendChild(txt);

		const x = doc.createElement('button');
		x.type = 'button';
		x.className = 'zhb-inline-x';
		x.title = '取消该段翻译（恢复原文）';
		x.textContent = '×';
		x.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.skipBlock(state, b);
		});
		el.appendChild(x);

		el._txtEl = txt;
		el._baseFs = baseFs;
		el._ownH = ownH;
		el._availH = availH;
		el._dst = b.dst;
		return el;
	},

	/** 字号适配：先直接放，放不下就二分缩小（最多 5 次测量），再不行才截断 */
	_fitEl(el) {
		try {
			const txt = el._txtEl;
			const win = el.ownerDocument.defaultView;
			const avail = el._availH;
			const base = el._baseFs;
			const floor = Math.max(4.5, base * 0.72);

			txt.style.display = 'block';
			txt.style.webkitLineClamp = '';
			txt.style.webkitBoxOrient = '';
			txt.style.overflow = 'hidden';

			el.style.fontSize = base + 'px';
			if (txt.scrollHeight <= avail + 1) return;

			let lo = floor;
			let hi = base;
			for (let i = 0; i < 5; i++) {
				const mid = (lo + hi) / 2;
				el.style.fontSize = mid + 'px';
				if (txt.scrollHeight <= avail + 1) lo = mid;
				else hi = mid;
			}
			const useFs = Math.max(floor, lo);
			el.style.fontSize = useFs + 'px';
			if (txt.scrollHeight <= avail + 1) return;

			// 仍放不下：按行数截断，悬停看全文
			let lh = useFs * 1.24;
			try {
				const cs = win.getComputedStyle(el);
				const parsed = parseFloat(cs.lineHeight);
				if (parsed > 0) lh = parsed;
			}
			catch (e) { /* ignore */ }
			const maxLines = Math.max(1, Math.floor(avail / lh));
			txt.style.display = '-webkit-box';
			txt.style.webkitLineClamp = String(maxLines);
			txt.style.webkitBoxOrient = 'vertical';
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	_repaintBlock(state, b) {
		try {
			if (state.mode !== 'inline') {
				this._paintBlock(b);
				return;
			}
			if (!state.pages) state.pages = new Map();
			if (!state.pages.get(b.page)) {
				const views = this._pageViews(state);
				for (let v of views) {
					if (v.pageNo === b.page) {
						this._ensurePage(state, b.page, v.div);
						break;
					}
				}
			}
			this._syncBlock(state, b);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	_rotationOK(state) {
		try {
			const app = this._viewerApp(state);
			const pv = app.pdfViewer.getPageView(0);
			const rot = (pv && pv.rotation) || 0;
			return (rot % 360) === 0;
		}
		catch (e) {
			return true;
		}
	},

	_buildBar(state) {
		const doc = this._viewerDoc(state);
		if (!doc) return;
		this._injectStyle(doc);
		const old = doc.getElementById('zhb-bar');
		if (old) old.remove();

		const bar = doc.createElement('div');
		bar.id = 'zhb-bar';
		bar.className = 'zhb-float';

		const handle = doc.createElement('div');
		handle.className = 'zhb-drag';
		handle.title = '按住拖动';
		handle.textContent = '⠿';

		const status = doc.createElement('span');
		status.className = 'zhb-status';
		status.textContent = '';

		const label = doc.createElement('span');
		label.className = 'zhb-label';
		label.textContent = '页数';

		const pageSel = doc.createElement('select');
		pageSel.className = 'zhb-select';
		const opts = [['1', '当前页'], ['2', '2 页'], ['3', '3 页'], ['5', '5 页'], ['10', '10 页'], ['all', '全部']];
		const curVal = String(this._pref('pdfPages', '3'));
		for (let o of opts) {
			const op = doc.createElement('option');
			op.value = o[0];
			op.textContent = o[1];
			if (o[0] === curVal) op.selected = true;
			pageSel.appendChild(op);
		}
		pageSel.addEventListener('change', () => {
			try {
				Zotero.Prefs.set('extensions.zhinfo.pdfPages', pageSel.value, true);
			}
			catch (e) {
				Zotero.logError(e);
			}
			state.limit = this._limitValue(state);
			state.startPage = this._currentPage(state) || state.startPage;
			state.aborted = false;
			this._updateHeader(state);
			this.run(state);
		});

		const mk = (btnLabel, fn) => {
			const btn = doc.createElement('button');
			btn.type = 'button';
			btn.className = 'zhb-btn';
			btn.textContent = btnLabel;
			btn.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				try {
					fn(btn);
				}
				catch (e) {
					Zotero.logError(e);
				}
			});
			return btn;
		};

		const btnStop = mk('停止', () => this.stop(state));
		const btnClear = mk('清除', () => this.clear(state));
		const btnToggle = mk('只看原文', (btn) => {
			state.showOriginal = !state.showOriginal;
			btn.textContent = state.showOriginal ? '显示译文' : '只看原文';
			this._renderInline(state);
		});
		const btnMin = mk('–', () => this._setCollapsed(state, true));
		btnMin.title = '最小化为圆形浮动图标';
		const btnClose = mk('关闭', () => this._closeView(state, false));

		const btnEngine = mk('生成双语PDF', () => this._runEngine(state));
		btnEngine.title = '调用开源引擎生成保留原版面的双语 PDF，并导入为子附件';
		const btnAbortEngine = mk('取消引擎', () => {
			try {
				ZHInfoEngine.abort(state.reader.itemID);
				this._setStatus(state, '已取消引擎任务');
			}
			catch (e) {
				Zotero.logError(e);
			}
		});

		bar.appendChild(handle);
		bar.appendChild(status);
		bar.appendChild(label);
		bar.appendChild(pageSel);
		bar.appendChild(btnEngine);
		bar.appendChild(btnAbortEngine);
		bar.appendChild(btnStop);
		bar.appendChild(btnClear);
		bar.appendChild(btnToggle);
		bar.appendChild(btnMin);
		bar.appendChild(btnClose);
		doc.documentElement.appendChild(bar);

		const fab = doc.createElement('div');
		fab.id = 'zhb-fab';
		fab.className = 'zhb-fab';
		fab.title = '双语工具（单击展开，可拖动）';
		fab.textContent = '译';
		fab.style.display = 'none';
		doc.documentElement.appendChild(fab);

		state.bar = bar;
		state.barEls = { status, btnStop, btnClear, btnToggle, pageSel, btnEngine, btnAbortEngine, btnMin, fab };
		this._makeDraggable(state, bar, handle);
		this._makeDraggable(state, fab, fab, () => this._setCollapsed(state, false));
		this._restoreBarPos(state, bar);
		this._restoreBarPos(state, fab);
		if (Zotero.Prefs.get('extensions.zhinfo.pdfBarMin', true)) {
			this._setCollapsed(state, true);
		}
	},

	/** 折叠成圆形浮动图标 / 展开浮条 */
	_setCollapsed(state, collapsed) {
		try {
			const els = state.barEls || {};
			if (!state.bar || !els.fab) return;
			state.collapsed = !!collapsed;
			state.bar.style.display = collapsed ? 'none' : '';
			els.fab.style.display = collapsed ? 'flex' : 'none';
			if (collapsed) {
				// 图标落到浮条当前所在处，避免跳位
				const r = state.bar.getBoundingClientRect();
				const doc = state.bar.ownerDocument;
				const win = doc.defaultView || {};
				const vw = win.innerWidth || 1200;
				const vh = win.innerHeight || 800;
				const laid = r.width > 0 || r.height > 0;
				const x = laid ? r.left : (vw - 62);
				const y = laid ? r.top : (vh - 120);
				const nx = Math.max(6, Math.min(vw - 50, x));
				const ny = Math.max(6, Math.min(vh - 50, y));
				els.fab.style.left = nx + 'px';
				els.fab.style.top = ny + 'px';
				els.fab.style.right = 'auto';
				els.fab.style.bottom = 'auto';
			}
			try {
				Zotero.Prefs.set('extensions.zhinfo.pdfBarMin', !!collapsed, true);
			}
			catch (e) { /* ignore */ }
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	/** 调用开源引擎（BabelDOC / PDFMathTranslate）生成保留原版面的双语 PDF */
	async _runEngine(state) {
		try {
			const attID = state.reader.itemID;
			const att = Zotero.Items.get(attID);
			if (!att) return;
			if (ZHInfoEngine.isRunning(attID)) {
				this._setStatus(state, '引擎任务进行中…');
				return;
			}
			const av = await ZHInfoEngine.available();
			if (!av.ok) {
				this._setStatus(state, '未检测到引擎，请先安装：uv tool install --python 3.12 --with "bitstring<5" BabelDOC');
				return;
			}
			const startPage = this._currentPage(state) || 1;
			const limit = this._limitValue(state);
			this._setStatus(state, '引擎启动：' + (limit === Infinity ? '整篇' : ('第 ' + startPage + ' 页起 ' + limit + ' 页')));
			const res = await ZHInfoEngine.enqueue({
				attachment: att,
				startPage,
				limit,
				onProgress: (chunk) => {
					const parts = String(chunk).split(/[\r\n]+/).filter(s => s.trim());
					const line = parts.length ? parts[parts.length - 1].trim() : '';
					if (line) this._setStatus(state, '『引擎』' + line.slice(0, 90));
				},
			});
			this._setStatus(state, '双语 PDF 已生成并作为子附件导入');
			try {
				await Zotero.Reader.open(res.attachment.id);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		catch (e) {
			Zotero.logError(e);
			const msg = (e && e.message ? e.message : String(e));
			this._setStatus(state, '引擎失败：' + msg);
			try {
				ZHInfoEngine.notify('双语 PDF 生成失败', msg, true);
			}
			catch (e2) { /* ignore */ }
		}
	},
	// ------------------------------------------------------------ reflow 视图（重排阅读）

	_buildView(state) {
		const doc = this._viewerDoc(state);
		if (!doc) return;
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
		title.textContent = '双语阅读';

		const status = doc.createElement('span');
		status.className = 'zhb-status';

		const mk = (label, fn) => {
			const btn = doc.createElement('button');
			btn.type = 'button';
			btn.className = 'zhb-btn';
			btn.textContent = label;
			btn.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				try {
					fn();
				}
				catch (e) {
					Zotero.logError(e);
				}
			});
			return btn;
		};

		bar.appendChild(title);
		bar.appendChild(status);
		bar.appendChild(mk('继续翻译', () => this.run(state)));
		bar.appendChild(mk('停止', () => this.stop(state)));
		bar.appendChild(mk('清除译文', () => this.clear(state)));
		bar.appendChild(mk('关闭', () => this._closeView(state, false)));

		const body = doc.createElement('div');
		body.className = 'zhb-body';

		root.appendChild(bar);
		root.appendChild(body);
		doc.documentElement.appendChild(root);

		state.root = root;
		state.list = body;
		state.barEls = { status };
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

	// ------------------------------------------------------------ 状态 / 关闭

	_setStatus(state, text) {
		try {
			if (state && state.barEls && state.barEls.status) state.barEls.status.textContent = text;
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
			const cur = this._currentPage(state);
			const maxPage = this._pageMax(state);
			const range = '第 ' + cur + ' 页' + (state.limit === Infinity ? ' · 全部' : ' · 上限 ' + this._limitLabel(state)
				+ (maxPage < 1e9 ? '（到第 ' + maxPage + ' 页）' : ''));
			this._setStatus(state, range + ' · ' + done + '/' + total + ' 段'
				+ (skip ? '（跳过 ' + skip + '）' : '') + (state.running ? ' · 翻译中' : ''));
			const els = state.barEls || {};
			if (els.btnStop) els.btnStop.disabled = !state.running;
			if (els.fab) els.fab.dataset.running = state.running ? '1' : '0';
		}
		catch (e) { /* ignore */ }
	},

	_closeView(state, immediate) {
		try {
			state.aborted = true;
			state.running = false;
			state.active = false;
			state.runToken = (state.runToken || 0) + 1;
			if (state.watcher) {
				clearInterval(state.watcher);
				state.watcher = null;
			}
			const doc = this._viewerDoc(state);
			if (doc) {
				const bar = doc.getElementById('zhb-bar');
				if (bar) bar.remove();
				const fabEl = doc.getElementById('zhb-fab');
				if (fabEl) fabEl.remove();
				const ov = doc.getElementById('zhb-overlay');
				if (ov) ov.remove();
				const layers = doc.querySelectorAll('.zhb-inline-layer');
				for (let i = 0; i < layers.length; i++) layers[i].remove();
				if (immediate) {
					const btn = doc.getElementById('zhb-toolbar-btn');
					if (btn) btn.remove();
				}
			}
			state.bar = null;
			state.barEls = {};
			state.pages = new Map();
			state.root = null;
			state.list = null;
			if (state.blocks) {
				for (let b of state.blocks) {
					b.el = null;
					b.dstEl = null;
				}
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// ------------------------------------------------------------ 页范围 / 跟随

	_currentPage(state) {
		try {
			const app = this._viewerApp(state);
			return (app && app.pdfViewer && app.pdfViewer.currentPageNumber) || 1;
		}
		catch (e) {
			return 1;
		}
	},

	_limitValue() {
		const raw = String(this._pref('pdfPages', '3'));
		if (raw === 'all') return Infinity;
		const n = parseInt(raw, 10);
		return (isNaN(n) || n < 1) ? 1 : n;
	},

	_limitLabel(state) {
		return state.limit === Infinity ? '全部' : (state.limit + ' 页');
	},

	_pageMax(state) {
		return state.limit === Infinity ? 1e9 : (state.startPage + state.limit - 1);
	},

	_beyondLimit(state) {
		return this._currentPage(state) > this._pageMax(state);
	},

	/** 下一个要翻译的页：优先当前页与其后一页（预取），再按页序补齐 */
	_nextPage(state) {
		const cur = this._currentPage(state);
		const maxPage = this._pageMax(state);
		const cands = [cur, cur + 1];
		for (let p = state.startPage; p <= maxPage; p++) cands.push(p);
		for (let p of cands) {
			if (p < 1 || p > maxPage) continue;
			if (!state.blocks.some(b => b.page === p && b.status === 'idle')) continue;
			return p;
		}
		return null;
	},

	// ------------------------------------------------------------ 浮条位置 / 拖动

	_restoreBarPos(state, bar) {
		let pos = '';
		try {
			pos = String(Zotero.Prefs.get('extensions.zhinfo.pdfBarPos', true) || '');
		}
		catch (e) { /* ignore */ }
		const m = pos.match(/^(-?\d+),(-?\d+)$/);
		if (!m) return;
		const doc = bar.ownerDocument;
		const win = doc.defaultView || {};
		const w = win.innerWidth || 1200;
		const h = win.innerHeight || 800;
		const x = Math.max(0, Math.min(w - 140, parseInt(m[1], 10)));
		const y = Math.max(0, Math.min(h - 40, parseInt(m[2], 10)));
		bar.style.left = x + 'px';
		bar.style.top = y + 'px';
		bar.style.right = 'auto';
		bar.style.bottom = 'auto';
	},

	_makeDraggable(state, bar, handle, onClick) {
		const doc = bar.ownerDocument;
		const win = doc.defaultView || {};
		let dragging = false;
		let moved = false;
		let sx = 0;
		let sy = 0;
		let ox = 0;
		let oy = 0;

		const onMove = (e) => {
			if (!dragging) return;
			const w = win.innerWidth || 1200;
			const h = win.innerHeight || 800;
			let nx = ox + (e.clientX - sx);
			let ny = oy + (e.clientY - sy);
			nx = Math.max(0, Math.min(w - bar.offsetWidth, nx));
			ny = Math.max(0, Math.min(h - bar.offsetHeight, ny));
			bar.style.left = nx + 'px';
			bar.style.top = ny + 'px';
			moved = true;
			e.preventDefault();
		};

		const onUp = () => {
			if (!dragging) return;
			dragging = false;
			try {
				doc.removeEventListener('mousemove', onMove, true);
				doc.removeEventListener('mouseup', onUp, true);
			}
			catch (e) { /* ignore */ }
			if (moved) {
				const r = bar.getBoundingClientRect();
				try {
					Zotero.Prefs.set('extensions.zhinfo.pdfBarPos', Math.round(r.left) + ',' + Math.round(r.top), true);
				}
				catch (e) {
					Zotero.logError(e);
				}
			}
			else if (onClick) {
				try {
					onClick();
				}
				catch (e) {
					Zotero.logError(e);
				}
			}
		};

		handle.addEventListener('mousedown', (e) => {
			dragging = true;
			moved = false;
			const r = bar.getBoundingClientRect();
			ox = r.left;
			oy = r.top;
			sx = e.clientX;
			sy = e.clientY;
			bar.style.left = ox + 'px';
			bar.style.top = oy + 'px';
			bar.style.right = 'auto';
			bar.style.bottom = 'auto';
			doc.addEventListener('mousemove', onMove, true);
			doc.addEventListener('mouseup', onUp, true);
			e.preventDefault();
			e.stopPropagation();
		}, true);
	},

	// ------------------------------------------------------------ 样式

	_injectStyle(doc) {
		try {
			if (!doc || !doc.head) return;
			if (doc.getElementById('zhb-style')) return;
			const style = doc.createElement('style');
			style.id = 'zhb-style';
			style.textContent = [
				'.zhb-toolbar-btn { font: inherit; font-size: 12px; padding: 2px 8px; margin: 0 4px; border-radius: 4px;'
					+ ' border: 1px solid rgba(127,127,127,.5); background: transparent; color: inherit; cursor: pointer; }',
				'.zhb-toolbar-btn:hover { background: rgba(127,127,127,.2); }',
				'.zhb-inline-layer { position: absolute; inset: 0; pointer-events: none; z-index: 6; }',
				'.zhb-inline { position: absolute; overflow: hidden; pointer-events: auto; background: #fff; color: #111;'
					+ ' padding: 1px 2px 1px 4px; box-sizing: border-box; border-radius: 2px; line-height: 1.24;'
					+ ' border-left: 2px solid rgba(47,111,235,.45);'
					+ ' font-family: system-ui, -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif; }',
				'.zhb-inline-text { display: block; overflow: hidden; text-align: justify; word-break: break-word; }',
				'.zhb-inline-x { position: absolute; top: -8px; right: -8px; width: 15px; height: 15px; padding: 0;'
					+ ' line-height: 13px; font-size: 11px; border-radius: 50%; cursor: pointer; opacity: 0;'
					+ ' border: 1px solid rgba(120,120,120,.85); background: #fff; color: #444; }',
				'.zhb-inline:hover .zhb-inline-x { opacity: 1; }',
				'.zhb-float { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; display: flex;'
					+ ' align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px; font-size: 12px;'
					+ ' background: rgba(255,255,255,.96); border: 1px solid rgba(120,120,120,.45); user-select: none;'
					+ ' box-shadow: 0 2px 10px rgba(0,0,0,.18); color: #111; font-family: system-ui, sans-serif; }',
				'.zhb-fab { position: fixed; z-index: 2147483001; width: 44px; height: 44px; border-radius: 50%;'
					+ ' display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700;'
					+ ' color: #fff; background: linear-gradient(180deg, #3b78f0, #1f57c3); cursor: pointer;'
					+ ' box-shadow: 0 4px 14px rgba(0,0,0,.3); user-select: none; border: none; }',
				'.zhb-fab:hover { filter: brightness(1.08); }',
				'.zhb-fab[data-running="1"]::after { content: ""; position: absolute; top: 3px; right: 3px;'
					+ ' width: 9px; height: 9px; border-radius: 50%; background: #ffd24a;'
					+ ' border: 1px solid rgba(0,0,0,.25); }',
				'.zhb-drag { cursor: move; user-select: none; opacity: .55; padding: 0 4px 0 0; font-size: 14px; }',
				'.zhb-drag:hover { opacity: 1; }',
				'.zhb-label { opacity: .7; }',
				'.zhb-select { font: inherit; font-size: 12px; padding: 1px 2px; border-radius: 4px;'
					+ ' border: 1px solid rgba(127,127,127,.5); background: transparent; color: inherit; }',
				'.zhb-overlay { position: fixed; inset: 0; z-index: 2147483000; overflow: auto;'
					+ ' background: var(--material-background, #fff); color: inherit; font-size: 15px; }',
				'.zhb-bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px;'
					+ ' padding: 10px 16px; border-bottom: 1px solid rgba(127,127,127,.35);'
					+ ' background: var(--material-background, #fff); flex-wrap: wrap; }',
				'.zhb-title { font-weight: 600; }',
				'.zhb-status { font-size: 12px; opacity: .75; }',
				'.zhb-btn { font: inherit; font-size: 12px; padding: 2px 10px; border-radius: 4px; cursor: pointer;'
					+ ' border: 1px solid rgba(127,127,127,.5); background: transparent; color: inherit; }',
				'.zhb-btn:hover { background: rgba(127,127,127,.18); }',
				'.zhb-btn[disabled] { opacity: .5; cursor: default; }',
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
		}
		catch (e) {
			Zotero.logError(e);
		}
	},
};