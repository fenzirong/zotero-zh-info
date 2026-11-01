/* Zotero 中文标题与摘要 —— bootstrap 入口（Zotero 7 / 8 / 10） */

if (typeof Zotero == 'undefined') {
	var Zotero;
}

var ZHInfo;
var chromeHandle;

function log(msg) {
	try {
		Zotero.debug('ZhInfo: ' + msg);
	}
	catch (e) {
		dump('ZhInfo: ' + msg + '\n');
	}
}

async function install() {
	log('installed');
}

async function startup({ id, version, rootURI }) {
	try {
		if (Zotero.initializationPromise) {
			await Zotero.initializationPromise;
		}

		// 注册 chrome://zhinfo/content/ 映射，使 jar 内的 CSS / SVG 图标可被样式表引用
		try {
			const aomStartup = Cc['@mozilla.org/addons/addon-manager-startup;1']
				.getService(Ci.amIAddonManagerStartup);
			const manifestURI = Services.io.newURI(rootURI + 'manifest.json');
			chromeHandle = aomStartup.registerChrome(manifestURI, [
				['content', 'zhinfo', 'content/'],
			]);
			log('chrome://zhinfo/ registered');
		}
		catch (e) {
			chromeHandle = null;
			Zotero.logError(e);
		}

		Services.scriptloader.loadSubScript(rootURI + 'content/translate.js');
		Services.scriptloader.loadSubScript(rootURI + 'content/zhinfo.js');

		ZHInfo.init({
			id,
			version,
			rootURI,
			hasChrome: !!chromeHandle,
		});

		await ZHInfo.startup();
		log('started v' + version);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function onMainWindowLoad({ window }) {
	try {
		if (ZHInfo) ZHInfo.addToWindow(window);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function onMainWindowUnload({ window }) {
	try {
		if (ZHInfo) ZHInfo.removeFromWindow(window);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

async function shutdown() {
	try {
		if (ZHInfo) await ZHInfo.shutdown();
	}
	catch (e) {
		Zotero.logError(e);
	}
	ZHInfo = undefined;

	if (chromeHandle) {
		try {
			chromeHandle.destruct();
		}
		catch (e) {
			Zotero.logError(e);
		}
		chromeHandle = null;
	}
	log('shutdown');
}

function uninstall() {
	log('uninstalled');
}
