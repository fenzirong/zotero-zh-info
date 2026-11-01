/* PDF 阅读器：划选段落翻译
 * 入口一：划选文本 → 弹出「翻译段落」，面板显示译文，可复制 / 存为笔记
 * 入口二：右键已有标注 → 翻译并复制到剪贴板
 */

if (typeof Zotero == 'undefined') {
	var Zotero;
}

var ZHInfoReader;

ZHInfoReader = {
	pluginID: null,
	_cache: null,
	_docs: null,
	_onSelection: null,
	_onAnnotationMenu: null,
	MAX_CACHE: 300,

	init({ pluginID }) {
		this.pluginID = pluginID;
		this._cache = new Map();
		this._docs = new WeakSet();

		this._onSelection = (event) => this._handleSelection(event);
		this._onAnnotationMenu = (event) => this._handleAnnotationMenu(event);

		try {
			Zotero.Reader.registerEventListener('renderTextSelectionPopup', this._onSelection, pluginID);
			Zotero.Reader.registerEventListener('createAnnotationContextMenu', this._onAnnotationMenu, pluginID);
			Zotero.debug('ZhInfo: reader listeners registered');
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	shutdown() {
		try {
			if (this._onSelection) Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', this._onSelection);
		}
		catch (e) {
			Zotero.logError(e);
		}
		try {
			if (this._onAnnotationMenu) Zotero.Reader.unregisterEventListener('createAnnotationContextMenu', this._onAnnotationMenu);
		}
		catch (e) {
			Zotero.logError(e);
		}
		this._onSelection = null;
		this._onAnnotationMenu = null;
		this._cache = null;
	},

	// ---------------------------------------------------------------- style

	_injectStyle(doc) {
		try {
			if (!doc || !doc.head || this._docs.has(doc)) return;
			const style = doc.createElement('style');
			style.textContent = [
				'.zhinfo-rd { margin-top: 6px; font-size: 13px; line-height: 1.6; max-width: 340px; }',
				'.zhinfo-rd-bar { display: flex; align-items: center; gap: 8px; }',
				'.zhinfo-rd-btn { font: inherit; font-size: 12px; padding: 1px 8px; border-radius: 4px; cursor: pointer;'
					+ ' border: 1px solid #c9c9c9; background: transparent; color: inherit; }',
				'.zhinfo-rd-btn:hover { background: rgba(127,127,127,.18); }',
				'.zhinfo-rd-btn[disabled] { opacity: .5; cursor: default; }',
				'.zhinfo-rd-status { font-size: 12px; opacity: .75; }',
				'.zhinfo-rd-status[data-kind="error"] { color: #d92b2b; opacity: 1; }',
				'.zhinfo-rd-status[data-kind="ok"] { color: #12805c; opacity: 1; }',
				'.zhinfo-rd-out { margin-top: 6px; padding: 6px 8px; border-radius: 5px; background: rgba(127,127,127,.12);'
					+ ' white-space: pre-wrap; word-break: break-word; display: none; }',
				'.zhinfo-rd-out[data-show="1"] { display: block; }',
				'.zhinfo-rd-actions { margin-top: 6px; display: flex; gap: 8px; }',
			].join('\n');
			doc.head.appendChild(style);
			this._docs.add(doc);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// ---------------------------------------------------------------- helpers

	_cacheKey(text) {
		let provider = 'mymemory';
		let lang = 'zh-CN';
		try {
			provider = ZHInfoTranslate.providerID;
			lang = ZHInfoTranslate.targetLang;
		}
		catch (e) { /* ignore */ }
		return provider + '|' + lang + '|' + text;
	},

	async _translate(text) {
		const key = this._cacheKey(text);
		if (this._cache && this._cache.has(key)) {
			return this._cache.get(key);
		}
		const out = await ZHInfoTranslate.translate(text, 'text');
		if (this._cache) {
			if (this._cache.size >= this.MAX_CACHE) {
				const first = this._cache.keys().next();
				if (!first.done) this._cache.delete(first.value);
			}
			this._cache.set(key, out);
		}
		return out;
	},

	_providerLabel() {
		try {
			return ZHInfoTranslate.providerName();
		}
		catch (e) {
			return '';
		}
	},

	// ---------------------------------------------------------------- 划选翻译

	_handleSelection({ reader, doc, params, append }) {
		try {
			const text = ((params && params.annotation && params.annotation.text) || '').trim();
			if (!text) return;
			this._injectStyle(doc);

			const box = doc.createElement('div');
			box.className = 'zhinfo-rd';

			const bar = doc.createElement('div');
			bar.className = 'zhinfo-rd-bar';

			const btn = doc.createElement('button');
			btn.type = 'button';
			btn.className = 'zhinfo-rd-btn zhinfo-rd-go';
			btn.textContent = '翻译段落';

			const status = doc.createElement('span');
			status.className = 'zhinfo-rd-status';

			bar.appendChild(btn);
			bar.appendChild(status);

			const out = doc.createElement('div');
			out.className = 'zhinfo-rd-out';

			const actions = doc.createElement('div');
			actions.className = 'zhinfo-rd-actions';

			box.appendChild(bar);
			box.appendChild(out);
			box.appendChild(actions);
			append(box);

			const copy = doc.createElement('button');
			copy.type = 'button';
			copy.className = 'zhinfo-rd-btn';
			copy.textContent = '复制译文';
			copy.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				try {
					Zotero.Utilities.Internal.copyTextToClipboard(out.textContent || '');
					status.textContent = '已复制';
					status.dataset.kind = 'ok';
				}
				catch (err) {
					Zotero.logError(err);
				}
			});

			const saveNote = doc.createElement('button');
			saveNote.type = 'button';
			saveNote.className = 'zhinfo-rd-btn';
			saveNote.textContent = '存为笔记';
			saveNote.addEventListener('click', async (e) => {
				e.preventDefault();
				e.stopPropagation();
				try {
					await this._saveNote(reader, text, out.textContent || '');
					status.textContent = '已保存到笔记';
					status.dataset.kind = 'ok';
				}
				catch (err) {
					Zotero.logError(err);
					status.textContent = '保存失败：' + (err && err.message ? err.message : err);
					status.dataset.kind = 'error';
				}
			});

			actions.appendChild(copy);
			actions.appendChild(saveNote);
			actions.style.display = 'none';

			btn.addEventListener('click', async (e) => {
				e.preventDefault();
				e.stopPropagation();
				btn.disabled = true;
				status.dataset.kind = '';
				status.textContent = '正在翻译（' + this._providerLabel() + '）…';
				try {
					const outText = await this._translate(text);
					out.textContent = outText;
					out.dataset.show = '1';
					actions.style.display = 'flex';
					status.textContent = '翻译完成';
					status.dataset.kind = 'ok';
				}
				catch (err) {
					Zotero.logError(err);
					status.textContent = '翻译失败：' + (err && err.message ? err.message : err);
					status.dataset.kind = 'error';
				}
				finally {
					btn.disabled = false;
				}
			});
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// ---------------------------------------------------------------- 标注右键

	_handleAnnotationMenu({ reader, params, append }) {
		try {
			const ids = (params && params.ids) || [];
			if (!ids.length) return;
			const texts = [];
			for (let id of ids) {
				const ann = Zotero.Items.get(id);
				const t = ann && (ann.annotationText || (ann.getNote && ann.getNote() ? '' : ''));
				if (t && t.trim()) texts.push(t.trim());
			}
			const text = texts.join('\n').trim();
			if (!text) return;

			append({
				label: '翻译标注为中文（复制）',
				onCommand: async () => {
					try {
						const out = await this._translate(text);
						Zotero.Utilities.Internal.copyTextToClipboard(out);
						const pw = new Zotero.ProgressWindow({ closeOnClick: true });
						pw.changeHeadline('已翻译并复制到剪贴板');
						pw.addDescription(String(out).slice(0, 120));
						pw.show();
						pw.startCloseTimer(6000);
					}
					catch (e) {
						Zotero.logError(e);
						try {
							const pw = new Zotero.ProgressWindow({ closeOnClick: true });
							pw.changeHeadline('翻译失败');
							pw.addDescription(String(e && e.message ? e.message : e).slice(0, 120));
							pw.show();
							pw.startCloseTimer(8000);
						}
						catch (e2) { /* ignore */ }
					}
				},
			});
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// ---------------------------------------------------------------- 存为笔记

	async _saveNote(reader, source, translation) {
		const parentID = reader && reader.itemID;
		const parent = parentID ? Zotero.Items.get(parentID) : null;
		if (!parent) throw new Error('找不到所属条目');

		const note = new Zotero.Item('note');
		note.libraryID = parent.libraryID;
		note.parentID = parent.id;
		const esc = (s) => String(s || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/\n/g, '<br/>');
		note.setNote(
			'<h2>中文翻译</h2>'
			+ '<p>' + esc(translation) + '</p>'
			+ '<hr/>'
			+ '<p><strong>原文</strong><br/>' + esc(source) + '</p>'
		);
		await note.saveTx();
		return note;
	},
};