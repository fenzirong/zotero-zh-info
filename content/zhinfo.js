/* Zotero 中文标题与摘要 —— 主逻辑
 *
 * 数据存储：条目 extra 字段中的两行
 *   中文标题: <译文>
 *   中文摘要: <译文（换行以字面 \n 保存）>
 * 这样无需修改数据库结构，可随 Zotero 同步，也能在「其他」区域直接看到。
 */

if (typeof Zotero == 'undefined') {
	var Zotero;
}

var ZHInfo;

ZHInfo = {
	id: null,
	version: null,
	rootURI: null,
	hasChrome: false,

	PREF: 'extensions.zhinfo.',
	KEY_TITLE: '中文标题',
	KEY_ABSTRACT: '中文摘要',
	FIELD_TITLE: 'title',
	FIELD_ABSTRACT: 'abstract',

	_sectionID: null,
	_prefPaneID: null,
	_menuID: null,
	_records: null,
	_states: null,
	_autoTried: null,
	_chain: null,

	// ------------------------------------------------------------ lifecycle

	init({ id, version, rootURI, hasChrome }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.hasChrome = !!hasChrome;
		this._records = new WeakMap();
		this._states = new Map();
		this._autoTried = new Set();
		this._chain = Promise.resolve();
		// 供设置面板脚本（独立全局作用域）访问
		Zotero.ZhInfo = this;
		if (typeof ZHInfoTranslate != 'undefined') {
			Zotero.ZhInfoTranslate = ZHInfoTranslate;
		}
	},

	async startup() {
		try {
			// 先把样式与本地化挂到已打开的主窗口，再注册分区，避免首帧无标签/无样式
			for (let win of Zotero.getMainWindows()) {
				this.addToWindow(win);
			}
			this.registerSection();
			this.registerMenu();
			this.registerReader();
			await this.registerPrefPane();
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	async shutdown() {
		try {
			if (typeof ZHInfoEngine != 'undefined' && ZHInfoEngine) {
				ZHInfoEngine.shutdown();
			}
			if (typeof ZHInfoBilingual != 'undefined' && ZHInfoBilingual) {
				ZHInfoBilingual.shutdown();
			}
			if (typeof ZHInfoReader != 'undefined' && ZHInfoReader) {
				ZHInfoReader.shutdown();
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		try {
			if (this._sectionID && Zotero.ItemPaneManager) {
				Zotero.ItemPaneManager.unregisterSection(this._sectionID);
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		this._sectionID = null;

		try {
			if (this._menuID && Zotero.MenuManager) {
				Zotero.MenuManager.unregisterMenu(this._menuID);
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		this._menuID = null;

		try {
			if (this._prefPaneID) {
				Zotero.PreferencePanes.unregister(this._prefPaneID);
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		this._prefPaneID = null;

		for (let win of Zotero.getMainWindows()) {
			this.removeFromWindow(win);
		}

		if (Zotero.ZhInfo === this) {
			delete Zotero.ZhInfo;
		}
		this._records = null;
		this._states = null;
		this._autoTried = null;
	},

	// ------------------------------------------------------------ window DOM

	_path(rel) {
		if (this.hasChrome) {
			return 'chrome://zhinfo/content/' + rel;
		}
		return this.rootURI + 'content/' + rel;
	},

	addToWindow(win) {
		try {
			if (win.MozXULElement && win.MozXULElement.insertFTLIfNeeded) {
				win.MozXULElement.insertFTLIfNeeded('zhinfo.ftl');
			}
		}
		catch (e) {
			Zotero.logError(e);
		}

		try {
			const doc = win.document;
			if (!doc.getElementById('zhinfo-stylesheet')) {
				const link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
				link.id = 'zhinfo-stylesheet';
				link.type = 'text/css';
				link.rel = 'stylesheet';
				link.href = this._path('style.css');
				doc.documentElement.appendChild(link);
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	removeFromWindow(win) {
		try {
			const doc = win.document;
			const sheet = doc.getElementById('zhinfo-stylesheet');
			if (sheet) sheet.remove();
			const ftl = doc.querySelector('[href="zhinfo.ftl"]');
			if (ftl) ftl.remove();
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// ------------------------------------------------------------ registration

	registerSection() {
		if (this._sectionID) return this._sectionID;
		if (!Zotero.ItemPaneManager) {
			Zotero.debug('ZhInfo: ItemPaneManager unavailable');
			return null;
		}

		const icon16 = this._path('icons/16/translate.svg');
		const icon16d = this._path('icons/16/translate-dark.svg');
		const icon20 = this._path('icons/20/translate.svg');
		const icon20d = this._path('icons/20/translate-dark.svg');

		const id = Zotero.ItemPaneManager.registerSection({
			paneID: 'zhinfo',
			pluginID: this.id,
			header: {
				l10nID: 'zhinfo-section-header',
				icon: icon16,
				darkIcon: icon16d,
			},
			sidenav: {
				l10nID: 'zhinfo-section-sidenav',
				icon: icon20,
				darkIcon: icon20d,
				orderable: true,
			},
			sectionButtons: [{
				type: 'zhinfo-translate-all',
				icon: icon16,
				darkIcon: icon16d,
				l10nID: 'zhinfo-button-translate-all',
				onClick: ({ item, body }) => {
					const rec = this._records && body ? this._records.get(body) : null;
					if (rec) this.translateAll(rec, { force: true });
					else if (item) this.translateItem(item, { force: true });
				},
			}],
			onItemChange: ({ item, setEnabled }) => {
				setEnabled(!!item && item.isRegularItem());
				return true;
			},
			onRender: ({ body, item, editable, doc }) => {
				this.renderSection({ body, item, editable, doc });
			},
		});

		this._sectionID = id || null;
		Zotero.debug('ZhInfo: section registered as ' + id);
		return id;
	},

	registerReader() {
		try {
			if (typeof ZHInfoReader != 'undefined' && ZHInfoReader) {
				ZHInfoReader.init({ pluginID: this.id });
			}
			if (typeof ZHInfoBilingual != 'undefined' && ZHInfoBilingual) {
				ZHInfoBilingual.init({ pluginID: this.id });
			}
			if (typeof ZHInfoEngine != 'undefined' && ZHInfoEngine) {
				ZHInfoEngine.init();
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	registerMenu() {
		if (!Zotero.MenuManager) {
			Zotero.debug('ZhInfo: MenuManager unavailable (Zotero < 8)，批量翻译请用 设置 → 中文标题与摘要');
			return;
		}
		try {
			this._menuID = Zotero.MenuManager.registerMenu({
				menuID: 'zhinfo-batch',
				pluginID: this.id,
				target: 'main/library/item',
				menus: [{
					menuType: 'menuitem',
					l10nID: 'zhinfo-menu-batch',
					onShowing: (event, context) => {
						try {
							const items = (context && context.items) || [];
							context.setVisible(items.some(it => it && it.isRegularItem && it.isRegularItem()));
						}
						catch (e) {
							Zotero.logError(e);
						}
					},
					onCommand: (event, context) => {
						const items = (context && context.items) || [];
						this.batchTranslate(items);
					},
				}],
			});
			Zotero.debug('ZhInfo: menu registered as ' + this._menuID);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	async registerPrefPane() {
		try {
			this._prefPaneID = await Zotero.PreferencePanes.register({
				pluginID: this.id,
				src: 'content/preferences.xhtml',
				id: 'zhinfo-pane',
				label: '中文标题与摘要',
				scripts: ['content/preferences.js'],
				stylesheets: ['content/preferences.css'],
			});
			Zotero.debug('ZhInfo: pref pane registered as ' + this._prefPaneID);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	openPreferences() {
		try {
			Zotero.Utilities.Internal.openPreferences(this._prefPaneID || 'zhinfo-pane', {});
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// ------------------------------------------------------------ prefs helpers

	pref(key, fallback) {
		const v = Zotero.Prefs.get(this.PREF + key, true);
		if (v === undefined || v === null || v === '') return fallback;
		return v;
	},

	// ------------------------------------------------------------ data layer

	escapeNL(s) {
		return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/\n/g, '\\n');
	},

	unescapeNL(s) {
		return String(s == null ? '' : s).replace(/\\n/g, '\n');
	},

	getData(item) {
		let title = '';
		let abstract = '';
		if (item) {
			const extra = item.getField('extra') || '';
			for (const line of extra.split('\n')) {
				const m = line.match(/^\s*(中文标题|中文摘要)\s*[:：]\s?(.*)$/);
				if (!m) continue;
				if (m[1] === this.KEY_TITLE) title = this.unescapeNL(m[2]);
				else abstract = this.unescapeNL(m[2]);
			}
		}
		return { title, abstract };
	},

	/** 计算合并后的 extra（保留其它行，只增删中文标题/摘要两行） */
	_mergeExtra(base, { title, abstract }) {
		const lines = base ? base.split('\n') : [];

		const apply = (key, value) => {
			const re = new RegExp('^\\s*' + key + '\\s*[:：]');
			const idx = lines.findIndex(l => re.test(l));
			const text = String(value == null ? '' : value).trim();
			const line = text ? key + ': ' + this.escapeNL(text) : null;
			if (idx > -1) {
				if (line === null) lines.splice(idx, 1);
				else lines[idx] = line;
			}
			else if (line !== null) {
				lines.push(line);
			}
		};

		apply(this.KEY_TITLE, title);
		apply(this.KEY_ABSTRACT, abstract);

		return lines
			.join('\n')
			.replace(/\n{3,}/g, '\n\n')
			.replace(/^\n+/, '')
			.replace(/\n+$/, '');
	},

	/** current 是否仍包含 base 里除中文两行之外的其它行 */
	_coversOtherLines(base, current) {
		const others = (base || '').split('\n').filter((l) => {
			if (!l.trim()) return false;
			return !new RegExp('^\\s*(' + this.KEY_TITLE + '|' + this.KEY_ABSTRACT + ')\\s*[:：]').test(l);
		});
		if (!others.length) return true;
		const cur = current || '';
		return others.every(l => cur.includes(l));
	},

	_hasKeys(extra, title, abstract) {
		const s = extra || '';
		if (String(title == null ? '' : title).trim() && !s.includes(this.KEY_TITLE + ':')) return false;
		if (String(abstract == null ? '' : abstract).trim() && !s.includes(this.KEY_ABSTRACT + ':')) return false;
		return true;
	},

	/**
	 * 写入中文标题/摘要。
	 * 说明：Zotero 信息面板的 Extra 编辑器在某些时序下会用旧值回写条目，
	 * 因此这里写入后会校验，必要时用写入前的基准值重试，避免误删用户其它行。
	 */
	async setData(item, { title, abstract }) {
		const wantTitle = String(title == null ? '' : title).trim();
		const wantAbstract = String(abstract == null ? '' : abstract).trim();
		const original = item.getField('extra') || '';

		for (let attempt = 0; attempt < 3; attempt++) {
			const current = item.getField('extra') || '';
			const base = this._coversOtherLines(original, current) ? current : original;
			const next = this._mergeExtra(base, { title: wantTitle, abstract: wantAbstract });
			if (next !== current) {
				item.setField('extra', next);
				await item.saveTx();
			}
			const after = item.getField('extra') || '';
			if (this._hasKeys(after, wantTitle, wantAbstract) && this._coversOtherLines(original, after)) {
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 400));
		}
		Zotero.debug('ZhInfo: setData 校验未通过（item ' + item.id + '），extra=' + JSON.stringify(item.getField('extra')));
	},

	isMostlyChinese(s) {
		if (!s) return false;
		const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
		const latin = (s.match(/[A-Za-z]/g) || []).length;
		if (!cjk) return false;
		return cjk * 2 >= latin;
	},

	// ------------------------------------------------------------ section render

	renderSection({ body, item, editable, doc }) {
		if (!body || !doc) return;

		const rec = {
			body,
			doc,
			item: item || null,
			editable: !!editable,
			titleInput: null,
			abstractInput: null,
			titleStatus: null,
			abstractStatus: null,
			saveTimer: null,
			dirty: false,
		};
		if (this._records) this._records.set(body, rec);

		this._build(rec);
		this._fillFromItem(rec);
		this._fallbackLabel(rec);
		this._maybeAutoTranslate(rec);
	},

	/** 某些语言下若 FTL 未解析，兜底显示标题 */
	_fallbackLabel(rec) {
		try {
			const sec = rec.body.closest('collapsible-section');
			if (sec && !sec.getAttribute('label')) {
				sec.setAttribute('label', '中文标题与摘要');
			}
		}
		catch (e) {
			// ignore
		}
	},

	_build(rec) {
		const { doc, body, item } = rec;
		body.textContent = '';

		const wrap = doc.createElement('div');
		wrap.className = 'zhinfo-pane';

		if (!item || !item.isRegularItem()) {
			const hint = doc.createElement('div');
			hint.className = 'zhinfo-hint';
			hint.textContent = '该分区仅适用于常规文献条目。';
			wrap.appendChild(hint);
			body.appendChild(wrap);
			return;
		}

		wrap.appendChild(this._fieldBlock(rec, this.FIELD_TITLE, '中文标题', true));
		wrap.appendChild(this._fieldBlock(rec, this.FIELD_ABSTRACT, '中文摘要', false));

		const footer = doc.createElement('div');
		footer.className = 'zhinfo-footer';

		const allBtn = this._button(rec, '一键翻译（仅填空）', () => {
			this.translateAll(rec, { force: false });
		});
		allBtn.disabled = !rec.editable;
		allBtn.classList.add('zhinfo-primary');

		const provider = doc.createElement('span');
		provider.className = 'zhinfo-provider';
		provider.textContent = '服务：' + ZHInfoTranslate.providerName();

		const setBtn = this._button(rec, '设置', () => this.openPreferences());
		setBtn.classList.add('zhinfo-link');

		footer.appendChild(allBtn);
		footer.appendChild(provider);
		footer.appendChild(setBtn);
		wrap.appendChild(footer);

		body.appendChild(wrap);
	},

	_fieldBlock(rec, field, labelText, isTitle) {
		const { doc, editable } = rec;

		const block = doc.createElement('div');
		block.className = 'zhinfo-block';

		const label = doc.createElement('div');
		label.className = 'zhinfo-label';
		label.textContent = labelText;
		block.appendChild(label);

		let input;
		if (isTitle) {
			input = doc.createElement('input');
			input.type = 'text';
			input.className = 'zhinfo-input';
			input.placeholder = '中文标题';
		}
		else {
			input = doc.createElement('textarea');
			input.className = 'zhinfo-textarea';
			input.rows = 6;
			input.placeholder = '中文摘要';
		}
		input.addEventListener('input', () => this._onEdit(rec));
		input.addEventListener('change', () => this._saveNow(rec));
		block.appendChild(input);
		rec[field + 'Input'] = input;

		const actions = doc.createElement('div');
		actions.className = 'zhinfo-actions';

		const tBtn = this._button(rec, '翻译', () => {
			this.translateField(rec, field, { force: true });
		});
		tBtn.classList.add('zhinfo-primary');
		tBtn.disabled = !editable;

		const cBtn = this._button(rec, '清空', () => this.clearField(rec, field));
		cBtn.disabled = !editable;

		const status = doc.createElement('span');
		status.className = 'zhinfo-status';

		actions.appendChild(tBtn);
		actions.appendChild(cBtn);
		actions.appendChild(status);
		block.appendChild(actions);

		rec[field + 'Status'] = status;
		input.disabled = !editable;
		return block;
	},

	_button(rec, text, onClick) {
		const btn = rec.doc.createElement('button');
		btn.type = 'button';
		btn.className = 'zhinfo-btn';
		btn.textContent = text;
		btn.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			try {
				onClick();
			}
			catch (e) {
				Zotero.logError(e);
			}
		});
		return btn;
	},

	_fillFromItem(rec) {
		if (!rec || !rec.item) return;
		const item = Zotero.Items.get(rec.item.id);
		if (!item) return;
		rec.item = item;

		const data = this.getData(item);
		const active = rec.doc ? rec.doc.activeElement : null;

		if (rec.titleInput && active !== rec.titleInput) {
			rec.titleInput.value = data.title || '';
		}
		if (rec.abstractInput && active !== rec.abstractInput) {
			rec.abstractInput.value = data.abstract || '';
		}
		this._updateStatus(rec, this.FIELD_TITLE);
		this._updateStatus(rec, this.FIELD_ABSTRACT);
	},

	// ------------------------------------------------------------ editing

	_onEdit(rec) {
		rec.dirty = true;
		if (rec.saveTimer) clearTimeout(rec.saveTimer);
		rec.saveTimer = setTimeout(() => this._saveNow(rec), 900);
	},

	async _saveNow(rec) {
		if (rec.saveTimer) {
			clearTimeout(rec.saveTimer);
			rec.saveTimer = null;
		}
		if (!rec.dirty) return;
		rec.dirty = false;

		const item = Zotero.Items.get(rec.item && rec.item.id);
		if (!item) return;

		try {
			await this.setData(item, {
				title: rec.titleInput ? rec.titleInput.value : '',
				abstract: rec.abstractInput ? rec.abstractInput.value : '',
			});
		}
		catch (e) {
			Zotero.logError(e);
			this._setStatus(rec, this.FIELD_TITLE, '保存失败：' + (e.message || e), 'error');
		}
	},

	async clearField(rec, field) {
		const item = Zotero.Items.get(rec.item && rec.item.id);
		if (!item) return;
		const data = this.getData(item);
		data[field] = '';
		try {
			await this.setData(item, data);
			this._states.delete(item.id + ':' + field);
			this._fillFromItem(rec);
		}
		catch (e) {
			Zotero.logError(e);
			this._setStatus(rec, field, '清空失败：' + (e.message || e), 'error');
		}
	},

	// ------------------------------------------------------------ status

	_setStatus(rec, field, msg, kind) {
		if (!rec || !rec.item) return;
		this._states.set(rec.item.id + ':' + field, { msg: msg || '', kind: kind || 'info' });
		this._updateStatus(rec, field);
	},

	_updateStatus(rec, field) {
		const el = rec[field + 'Status'];
		if (!el || !rec.item) return;
		const st = this._states.get(rec.item.id + ':' + field);
		el.textContent = st && st.msg ? st.msg : '';
		el.dataset.kind = st && st.kind ? st.kind : '';
	},

	// ------------------------------------------------------------ translation

	_enqueue(fn) {
		const run = this._chain.then(() => fn());
		this._chain = run.catch(() => {});
		return run;
	},

	async translateField(rec, field, { force = false } = {}) {
		const item = Zotero.Items.get(rec.item && rec.item.id);
		if (!item) return;
		rec.item = item;

		const key = item.id + ':' + field;
		const st0 = this._states.get(key);
		if (st0 && st0.kind === 'busy') return;

		const source = field === this.FIELD_TITLE
			? (item.getField('title') || '')
			: (item.getField('abstractNote') || '');

		if (!source.trim()) {
			this._setStatus(rec, field, field === this.FIELD_TITLE
				? '原标题为空，无法翻译'
				: '原摘要为空，无法翻译（可先在「摘要」分区填写）', 'error');
			return;
		}

		if (!force && this.pref('skipIfChinese', true) && this.isMostlyChinese(source)) {
			this._setStatus(rec, field, '原文已是中文，已跳过', 'info');
			return;
		}

		this._setStatus(rec, field, '正在翻译…', 'busy');
		this._autoTried.add(item.id);

		try {
			const out = await this._enqueue(() => ZHInfoTranslate.translate(source, field));
			const data = this.getData(item);
			data[field] = out;
			await this.setData(item, data);
			this._setStatus(rec, field, '翻译完成', 'ok');
			this._fillFromItem(rec);
		}
		catch (e) {
			Zotero.logError(e);
			this._setStatus(rec, field, '翻译失败：' + (e && e.message ? e.message : e), 'error');
		}
	},

	/** 分区的状态键是 itemID:field，这里把 busy 标记清掉以便重试 */
	_clearBusy(itemID, field) {
		const key = itemID + ':' + field;
		const st = this._states.get(key);
		if (st && st.kind === 'busy') this._states.delete(key);
	},

	/** 单条目翻译（无 UI 记录时的入口，用于批量） */
	async translateItem(item, { force = false } = {}) {
		if (!item || !item.isRegularItem()) return { ok: false, skipped: true };
		const data = this.getData(item);
		let changed = false;

		const jobs = [];
		if (force || !data.title) jobs.push(this.FIELD_TITLE);
		if (force || !data.abstract) jobs.push(this.FIELD_ABSTRACT);

		for (const field of jobs) {
			this._clearBusy(item.id, field);
			const source = field === this.FIELD_TITLE
				? (item.getField('title') || '')
				: (item.getField('abstractNote') || '');
			if (!source.trim()) continue;
			if (!force && this.pref('skipIfChinese', true) && this.isMostlyChinese(source)) continue;
			const out = await this._enqueue(() => ZHInfoTranslate.translate(source, field));
			data[field] = out;
			changed = true;
		}

		if (changed) {
			await this.setData(item, data);
		}
		return { ok: changed };
	},

	translateAll(rec, { force = false } = {}) {
		(async () => {
			if (!rec || !rec.item) return;
			await this.translateField(rec, this.FIELD_TITLE, { force });
			await this.translateField(rec, this.FIELD_ABSTRACT, { force });
		})().catch(e => Zotero.logError(e));
	},

	_maybeAutoTranslate(rec) {
		if (!rec || !rec.item || !rec.editable) return;
		if (!this.pref('autoTranslate', true)) return;
		if (this._autoTried.has(rec.item.id)) return;

		const data = this.getData(rec.item);
		const needTitle = !data.title;
		const needAbstract = !data.abstract;

		this._autoTried.add(rec.item.id);
		if (needTitle) this.translateField(rec, this.FIELD_TITLE, { force: false });
		if (needAbstract) this.translateField(rec, this.FIELD_ABSTRACT, { force: false });
	},

	// ------------------------------------------------------------ batch

	async batchTranslate(items) {
		const list = (items || []).filter(it => it && it.isRegularItem && it.isRegularItem());
		if (!list.length) {
			Zotero.debug('ZhInfo: batch translate — no regular items selected');
			return;
		}

		let pw = null;
		try {
			pw = new Zotero.ProgressWindow({ closeOnClick: true });
			pw.changeHeadline('批量翻译中文标题与摘要');
			pw.show();
		}
		catch (e) {
			Zotero.logError(e);
			pw = null;
		}

		let done = 0;
		let failed = 0;
		for (let i = 0; i < list.length; i++) {
			const item = list[i];
			const short = String(item.getField('title') || '').slice(0, 40);
			try {
				if (pw) pw.changeHeadline('(' + (i + 1) + '/' + list.length + ') ' + short);
				const r = await this.translateItem(item, { force: false });
				if (r && r.ok) done++;
			}
			catch (e) {
				failed++;
				Zotero.logError(e);
			}
			await new Promise(resolve => setTimeout(resolve, 400));
		}

		try {
			if (pw) {
				pw.changeHeadline('批量翻译完成');
				pw.addDescription('已更新 ' + done + ' 条' + (failed ? '，失败 ' + failed + ' 条' : ''));
				pw.startCloseTimer(6000);
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	},
};
