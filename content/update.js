/* 插件自更新：读自身 manifest 的 update_url -> 取更新清单 -> 比较版本 -> 下载 XPI -> 调 XPIInstall 安装
 * 说明：Zotero 自身的插件更新检查依赖 Firefox 的定时器与静默策略，实践中常不触发，
 *       因此这里自己做一套显式检查（设置面板可见、可手动触发、启动时静默查一次）。
 */

if (typeof Zotero == 'undefined') {
	var Zotero;
}

var ZHInfoUpdate;

ZHInfoUpdate = {
	id: null,
	version: null,
	rootURI: null,
	_running: false,

	init(env) {
		this.id = env.id;
		this.version = env.version;
		this.rootURI = env.rootURI;
	},

	// ------------------------------------------------------------ 版本比较

	_parse(v) {
		return String(v || '0').split(/[.\-+]/).map(x => {
			const n = parseInt(x, 10);
			return isNaN(n) ? 0 : n;
		});
	},

	/** a > b 返回 1，相等 0，小于 -1 */
	cmp(a, b) {
		const pa = this._parse(a);
		const pb = this._parse(b);
		const len = Math.max(pa.length, pb.length);
		for (let i = 0; i < len; i++) {
			const x = pa[i] || 0;
			const y = pb[i] || 0;
			if (x > y) return 1;
			if (x < y) return -1;
		}
		return 0;
	},

	// ------------------------------------------------------------ 清单

	async _updateURL() {
		const override = String(ZHInfo.pref('updateUrl', '') || '').trim();
		if (override) return override;
		const text = await Zotero.File.getContentsFromURL(this.rootURI + 'manifest.json');
		const mf = JSON.parse(text);
		const url = mf && mf.applications && mf.applications.zotero && mf.applications.zotero.update_url;
		if (!url) throw new Error('插件 manifest 里没有 applications.zotero.update_url');
		return url;
	},

	/** 手动指定清单地址时给测试用 */
	setVersionForTest(v) {
		this.version = v;
	},

	async check() {
		const url = await this._updateURL();
		const xhr = await Zotero.HTTP.request('GET', url, {
			responseType: 'json',
			timeout: 20000,
			successCodes: false,
		});
		if (xhr.status !== 200 || !xhr.response) {
			throw new Error('更新清单获取失败（HTTP ' + xhr.status + '）');
		}
		const data = xhr.response;
		const entry = data && data.addons && data.addons[this.id];
		const list = (entry && entry.updates) || [];
		const zv = Zotero.version;

		let best = null;
		for (let u of list) {
			if (!u || !u.version || !u.update_link) continue;
			const app = (u.applications && u.applications.zotero) || {};
			if (app.strict_min_version && this.cmp(zv, app.strict_min_version) < 0) continue;
			if (app.strict_max_version && this.cmp(zv, app.strict_max_version) > 0) continue;
			if (this.cmp(u.version, this.version) <= 0) continue;
			if (!best || this.cmp(u.version, best.version) > 0) best = u;
		}

		try {
			Zotero.Prefs.set('extensions.zhinfo.updateLastCheck', Date.now(), true);
			Zotero.Prefs.set('extensions.zhinfo.updateAvailable', best ? best.version : '', true);
		}
		catch (e) { /* ignore */ }

		return {
			current: this.version,
			zotero: zv,
			available: !!best,
			version: best ? best.version : this.version,
			link: best ? best.update_link : '',
			url,
		};
	},

	// ------------------------------------------------------------ 下载并安装

	async install(link, version) {
		if (this._running) throw new Error('已有更新任务在进行');
		this._running = true;
		try {
			const xhr = await Zotero.HTTP.request('GET', link, {
				responseType: 'arraybuffer',
				timeout: 180000,
				successCodes: false,
			});
			if (xhr.status !== 200 || !xhr.response) {
				throw new Error('下载更新包失败（HTTP ' + xhr.status + '）');
			}
			const dir = PathUtils.join(Zotero.getTempDirectory().path, 'zhinfo-update');
			await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
			const path = PathUtils.join(dir, 'zhinfo-' + (version || 'new') + '.xpi');
			await IOUtils.write(path, new Uint8Array(xhr.response));
			Zotero.debug('ZhInfo: update downloaded to ' + path);

			const { XPIInstall } = ChromeUtils.importESModule('resource://gre/modules/addons/XPIInstall.sys.mjs');
			const file = Zotero.File.pathToFile(path);
			const install = await XPIInstall.getInstallForFile(file);
			if (!install) throw new Error('更新包无效（无法创建安装任务）');

			await new Promise((resolve, reject) => {
				const ok = () => resolve();
				const bad = (e) => reject(new Error('安装失败：' + (e && (e.message || e))));
				try {
					install.addListener({
						onInstallEnded: ok,
						onInstallFailed: bad,
						onDownloadFailed: bad,
					});
				}
				catch (e) { /* 旧版没有 addListener */ }
				try {
					install.install();
				}
				catch (e) {
					bad(e);
				}
			});
			this.notify('插件更新已下载', '重启 Zotero 后生效（新版本 ' + (version || '') + '）');
			return { path, version };
		}
		finally {
			this._running = false;
		}
	},

	notify(headline, body) {
		try {
			const pw = new Zotero.ProgressWindow({ closeOnClick: true });
			pw.changeHeadline(headline);
			if (body) pw.addDescription(String(body).slice(0, 180));
			pw.show();
			pw.startCloseTimer(9000);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// ------------------------------------------------------------ 启动时静默检查

	async autoCheck() {
		try {
			if (!ZHInfo.pref('updateAuto', true)) return;
			const last = parseInt(String(ZHInfo.pref('updateLastCheck', 0) || 0), 10) || 0;
			const day = 24 * 60 * 60 * 1000;
			if (last && (Date.now() - last) < day) return;
			const r = await this.check();
			if (r.available) {
				this.notify('插件有新版本 ' + r.version, '当前 ' + r.current + '，可在 设置 → 中文标题与摘要 → 六、更新 里一键安装');
			}
			else {
				Zotero.debug('ZhInfo: 已是最新版本 ' + r.current);
			}
		}
		catch (e) {
			Zotero.debug('ZhInfo: 自动更新检查失败 ' + (e && e.message));
		}
	},
};