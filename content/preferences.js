/* 设置面板脚本：手动双向绑定首选项，不依赖 <preference> 绑定，兼容各版本 */

(function () {
	const P = {
		provider: 'extensions.zhinfo.provider',
		targetLang: 'extensions.zhinfo.targetLang',
		auto: 'extensions.zhinfo.autoTranslate',
		skipZh: 'extensions.zhinfo.skipIfChinese',
		llmBase: 'extensions.zhinfo.llm.baseURL',
		llmKey: 'extensions.zhinfo.llm.apiKey',
		llmModel: 'extensions.zhinfo.llm.model',
		llmExtra: 'extensions.zhinfo.llm.abstractPrompt',
		deeplKey: 'extensions.zhinfo.deepl.apiKey',
		deeplFree: 'extensions.zhinfo.deepl.free',
		mmEmail: 'extensions.zhinfo.mymemory.email',
		mmSrc: 'extensions.zhinfo.mymemory.sourceLang',
		pdfAuto: 'extensions.zhinfo.pdfAuto',
		pdfScope: 'extensions.zhinfo.pdfScope',
		pdfMin: 'extensions.zhinfo.pdfMinChars',
		pdfMode: 'extensions.zhinfo.pdfMode',
		pdfPages: 'extensions.zhinfo.pdfPages',
		pdfFollow: 'extensions.zhinfo.pdfFollow',
		pdfEngine: 'extensions.zhinfo.pdfEngine',
		pdfEnginePath: 'extensions.zhinfo.pdfEnginePath',
		pdf2zhService: 'extensions.zhinfo.pdf2zhService',
		engineThread: 'extensions.zhinfo.engineThread',
		engineThinking: 'extensions.zhinfo.engineThinking',
		enginePages: 'extensions.zhinfo.enginePages',
		updateAuto: 'extensions.zhinfo.updateAuto',
		engineLangIn: 'extensions.zhinfo.engineLangIn',
		engineSkipScanned: 'extensions.zhinfo.engineSkipScanned',
	};

	let initialized = false;
	let attempts = 0;

	function q(id) {
		return window.document.getElementById(id);
	}

	function getStr(name, fallback) {
		const v = Zotero.Prefs.get(name, true);
		return (v === undefined || v === null) ? fallback : String(v);
	}

	function setStr(name, value) {
		try {
			Zotero.Prefs.set(name, String(value == null ? '' : value), true);
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	function getBool(name, fallback) {
		const v = Zotero.Prefs.get(name, true);
		return (v === undefined || v === null) ? fallback : !!v;
	}

	function setBool(name, value) {
		try {
			Zotero.Prefs.set(name, !!value, true);
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	function bindText(id, pref) {
		const el = q(id);
		if (!el) return;
		el.value = getStr(pref, '');
		el.addEventListener('change', () => setStr(pref, el.value));
		el.addEventListener('input', () => setStr(pref, el.value));
		el.addEventListener('blur', () => setStr(pref, el.value));
	}

	function bindNumber(id, pref, dflt) {
		const el = q(id);
		if (!el) return;
		const v = getStr(pref, String(dflt));
		el.value = v;
		el.addEventListener('change', () => {
			let n = parseInt(el.value, 10);
			if (isNaN(n) || n < 1) n = dflt;
			el.value = String(n);
			try {
				Zotero.Prefs.set(pref, n, true);
			}
			catch (e) {
				Zotero.logError(e);
			}
		});
	}

	function bindSelect(id, pref) {
		const el = q(id);
		if (!el) return;
		el.value = getStr(pref, '');
		const onPick = () => {
			setStr(pref, el.value);
			updateVisibility();
		};
		el.addEventListener('command', onPick);
		el.addEventListener('change', onPick);
	}

	function bindCheck(id, pref, fallback) {
		const el = q(id);
		if (!el) return;
		el.checked = getBool(pref, fallback);
		el.addEventListener('command', () => setBool(pref, el.checked));
		el.addEventListener('change', () => setBool(pref, el.checked));
		el.addEventListener('click', () => {
			setTimeout(() => setBool(pref, el.checked), 0);
		});
	}

	function setUpdateStatus(text, kind) {
		const el = q('zhinfo-update-status');
		if (!el) return;
		el.textContent = text;
		el.dataset.kind = kind || '';
	}

	function initUpdateUI() {
		const U = Zotero.ZhInfoUpdate;
		const cur = q('zhinfo-update-current');
		if (cur) cur.textContent = U ? U.version : '未知';

		let lastResult = null;

		const btnCheck = q('zhinfo-btn-update-check');
		const onCheck = async () => {
			setUpdateStatus('正在检查更新…', 'busy');
			try {
				const u = Zotero.ZhInfoUpdate;
				if (!u) throw new Error('更新模块未加载，请重启 Zotero');
				const r = await u.check();
				lastResult = r;
				if (r.available) setUpdateStatus('发现新版本 ' + r.version + '（当前 ' + r.current + '）', 'ok');
				else setUpdateStatus('已是最新版本 ' + r.current, 'ok');
			}
			catch (e) {
				Zotero.logError(e);
				setUpdateStatus('检查失败：' + (e && e.message ? e.message : e), 'error');
			}
		};

		const btnInstall = q('zhinfo-btn-update-install');
		const onInstall = async () => {
			try {
				const u = Zotero.ZhInfoUpdate;
				if (!u) throw new Error('更新模块未加载，请重启 Zotero');
				if (!lastResult || !lastResult.available) {
					setUpdateStatus('请先点「检查更新」', 'error');
					return;
				}
				setUpdateStatus('正在下载 ' + lastResult.version + '…', 'busy');
				await u.install(lastResult.link, lastResult.version);
				setUpdateStatus('已下载并安装，请重启 Zotero 生效', 'ok');
			}
			catch (e) {
				Zotero.logError(e);
				setUpdateStatus('安装失败：' + (e && e.message ? e.message : e), 'error');
			}
		};

		if (btnCheck) {
			btnCheck.addEventListener('command', onCheck);
			btnCheck.addEventListener('click', onCheck);
		}
		if (btnInstall) {
			btnInstall.addEventListener('command', onInstall);
			btnInstall.addEventListener('click', onInstall);
		}
	}

	function updateVisibility() {
		const providerEl = q('zhinfo-pref-provider');
		const provider = providerEl ? providerEl.value : getStr(P.provider, 'google');
		const map = {
			llm: 'zhinfo-group-llm',
			deepl: 'zhinfo-group-deepl',
			mymemory: 'zhinfo-group-mymemory',
			google: 'zhinfo-group-google',
		};
		for (const key of Object.keys(map)) {
			const box = q(map[key]);
			if (!box) continue;
			box.hidden = key !== provider;
		}
		const engineEl = q('zhinfo-pref-engine');
		const engine = engineEl ? engineEl.value : getStr(P.pdfEngine, 'auto');
		const svcRow = q('zhinfo-row-pdf2zhservice');
		if (svcRow) svcRow.hidden = !(engine === 'pdf2zh' || engine === 'auto');
	}

	function setEngineStatus(text, kind) {
		const el = q('zhinfo-engine-status');
		if (!el) return;
		el.textContent = text;
		el.dataset.kind = kind || '';
	}

	function setResult(text, kind) {
		const el = q('zhinfo-test-result');
		if (!el) return;
		el.textContent = text;
		el.dataset.kind = kind || '';
	}

	async function onTest() {
		setResult('正在测试…', 'busy');
		try {
			const T = Zotero.ZhInfoTranslate;
			if (!T) throw new Error('插件未完全加载，请重启 Zotero 后重试');
			const sample = 'Retrieval-augmented generation for knowledge-intensive NLP tasks';
			const out = await T.translate(sample, 'title');
			setResult('成功（' + T.providerName() + '）：' + out, 'ok');
		}
		catch (e) {
			Zotero.logError(e);
			setResult('失败：' + (e && e.message ? e.message : e), 'error');
		}
	}

	function onBatch() {
		try {
			const Z = Zotero.ZhInfo;
			if (!Z) throw new Error('插件未完全加载');
			const pane = Zotero.getActiveZoteroPane();
			const items = pane ? pane.getSelectedItems() : [];
			if (!items || !items.length) {
				setResult('请先在文献列表中选中条目', 'error');
				return;
			}
			setResult('已开始批量翻译 ' + items.length + ' 条，进度见右下角提示', 'busy');
			Z.batchTranslate(items);
		}
		catch (e) {
			Zotero.logError(e);
			setResult('失败：' + (e && e.message ? e.message : e), 'error');
		}
	}

	function init() {
		if (initialized) return;
		attempts++;
		if (!q('zhinfo-pref-provider')) {
			if (attempts < 60) setTimeout(init, 100);
			return;
		}
		initialized = true;

		bindSelect('zhinfo-pref-provider', P.provider);
		bindSelect('zhinfo-pref-targetlang', P.targetLang);
		bindCheck('zhinfo-pref-auto', P.auto, true);
		bindCheck('zhinfo-pref-skipzh', P.skipZh, true);

		bindText('zhinfo-pref-llm-base', P.llmBase);
		bindText('zhinfo-pref-llm-key', P.llmKey);
		bindText('zhinfo-pref-llm-model', P.llmModel);
		bindText('zhinfo-pref-llm-extra', P.llmExtra);

		bindText('zhinfo-pref-deepl-key', P.deeplKey);
		bindCheck('zhinfo-pref-deepl-free', P.deeplFree, true);

		bindText('zhinfo-pref-mm-email', P.mmEmail);
		bindText('zhinfo-pref-mm-src', P.mmSrc);

		bindCheck('zhinfo-pref-pdfauto', P.pdfAuto, false);
		bindSelect('zhinfo-pref-pdfpages', P.pdfPages);
		bindCheck('zhinfo-pref-pdffollow', P.pdfFollow, true);
		bindSelect('zhinfo-pref-engine', P.pdfEngine);
		bindText('zhinfo-pref-enginepath', P.pdfEnginePath);
		bindText('zhinfo-pref-pdf2zhservice', P.pdf2zhService);
		bindNumber('zhinfo-pref-enginethread', P.engineThread, 4);
		bindSelect('zhinfo-pref-enginethinking', P.engineThinking);
		bindSelect('zhinfo-pref-enginepages', P.enginePages);
		bindCheck('zhinfo-pref-updateauto', P.updateAuto, true);
		initUpdateUI();
		bindText('zhinfo-pref-enginelangin', P.engineLangIn);
		bindCheck('zhinfo-pref-engineskipscanned', P.engineSkipScanned, false);
		bindNumber('zhinfo-pref-pdfmin', P.pdfMin, 20);
		bindSelect('zhinfo-pref-pdfmode', P.pdfMode);

		const testBtn = q('zhinfo-btn-test');
		if (testBtn) {
			testBtn.addEventListener('command', onTest);
			testBtn.addEventListener('click', onTest);
		}
		const engineBtn = q('zhinfo-btn-engine');
	if (engineBtn) {
		const onEngineTest = async () => {
			setEngineStatus('正在检测引擎…', 'busy');
			try {
				const E = Zotero.ZhInfoEngine || (typeof ZHInfoEngine != 'undefined' ? ZHInfoEngine : null);
				if (!E) throw new Error('引擎模块未加载，请重启 Zotero');
				const info = await E.describe();
				setEngineStatus(info.text, info.ok ? 'ok' : 'error');
			}
			catch (e) {
				Zotero.logError(e);
				setEngineStatus('检测失败：' + (e && e.message ? e.message : e), 'error');
			}
		};
		engineBtn.addEventListener('command', onEngineTest);
		engineBtn.addEventListener('click', onEngineTest);
	}

	const batchBtn = q('zhinfo-btn-batch');
		if (batchBtn) {
			batchBtn.addEventListener('command', onBatch);
			batchBtn.addEventListener('click', onBatch);
		}

		updateVisibility();
	}

	init();
})();