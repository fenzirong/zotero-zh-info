/* 翻译服务适配层：Google / MyMemory / DeepL / OpenAI 兼容大模型 */

var ZHInfoTranslate = {
	LABELS: {
		google: 'Google 翻译（免费接口）',
		mymemory: 'MyMemory（免费，限流）',
		deepl: 'DeepL API',
		llm: '大模型 API（OpenAI 兼容）',
	},

	get providerID() {
		return Zotero.Prefs.get('extensions.zhinfo.provider', true) || 'mymemory';
	},

	get targetLang() {
		return Zotero.Prefs.get('extensions.zhinfo.targetLang', true) || 'zh-CN';
	},

	get timeout() {
		return Zotero.Prefs.get('extensions.zhinfo.timeout', true) || 30000;
	},

	providerName(id) {
		id = id || this.providerID;
		return this.LABELS[id] || id;
	},

	/**
	 * @param {string} text 待翻译文本
	 * @param {'title'|'abstract'} kind 文本类型
	 * @returns {Promise<string>}
	 */
	async translate(text, kind) {
		const src = String(text || '').trim();
		if (!src) {
			throw new Error('文本为空，无可翻译内容');
		}
		const pid = this.providerID;
		let out;
		switch (pid) {
			case 'google':
				out = await this.google(src);
				break;
			case 'mymemory':
				out = await this.mymemory(src);
				break;
			case 'deepl':
				out = await this.deepl(src);
				break;
			case 'llm':
				out = await this.llm(src, kind === 'abstract' ? 'abstract' : 'title');
				break;
			default:
				throw new Error('未知的翻译服务：' + pid + '（请在设置中重新选择）');
		}
		if (this._sameAsSource(src, out)) {
			throw new Error('翻译服务返回了原文（可能已达限额或该语言对不可用），请稍后重试或改用「大模型 API」');
		}
		return out;
	},

	/** 归一化比较：忽略大小写、空白与标点 */
	_norm(s) {
		return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
	},

	_sameAsSource(src, out) {
		const a = this._norm(src);
		const b = this._norm(out);
		if (!a || !b) return false;
		return a === b;
	},

	// ---------------------------------------------------------------- HTTP

	async _request(method, url, options = {}) {
		let xhr;
		try {
			xhr = await Zotero.HTTP.request(method, url, Object.assign({
				responseType: 'json',
				timeout: this.timeout || 30000,
				successCodes: false,
				headers: {},
			}, options));
		}
		catch (e) {
			const msg = e && e.message ? e.message : String(e);
			throw new Error('网络请求失败（' + msg + '）');
		}

		let data = xhr.response;
		if (data === null || data === undefined || typeof data === 'string') {
			try {
				data = JSON.parse(xhr.responseText);
			}
			catch (e) {
				data = null;
			}
		}

		if (xhr.status < 200 || xhr.status >= 300) {
			let detail = '';
			if (data && typeof data === 'object') {
				detail = (data.error && (data.error.message || data.error))
					|| data.message
					|| data.responseDetails
					|| '';
			}
			if (typeof detail !== 'string') {
				try {
					detail = JSON.stringify(detail);
				}
				catch (e) {
					detail = '';
				}
			}
			if (!detail) {
				detail = String(xhr.responseText || '').slice(0, 200);
			}
			throw new Error('HTTP ' + xhr.status + (detail ? '：' + detail : ''));
		}

		if (data === null || data === undefined) {
			throw new Error('返回内容无法解析（可能被接口限制或需要代理）');
		}
		return data;
	},

	// ---------------------------------------------------------------- utils

	sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	},

	/** 按句读切分，避免超出各接口的单次长度限制 */
	_chunk(text, max) {
		const s = String(text);
		if (s.length <= max) return [s];
		const parts = [];
		let cur = '';
		const segments = s.split(/([。！？!?；;\.\n])/);
		for (let i = 0; i < segments.length; i += 2) {
			const seg = (segments[i] || '') + (segments[i + 1] || '');
			if (!seg) continue;
			if (cur && (cur.length + seg.length) > max) {
				parts.push(cur);
				cur = '';
			}
			cur += seg;
			while (cur.length > max) {
				parts.push(cur.slice(0, max));
				cur = cur.slice(max);
			}
		}
		if (cur) parts.push(cur);
		return parts.length ? parts : [s];
	},

	// ---------------------------------------------------------------- Google

	async google(text) {
		const chunks = this._chunk(text, 1200);
		const out = [];
		for (let i = 0; i < chunks.length; i++) {
			const url = 'https://translate.googleapis.com/translate_a/single'
				+ '?client=gtx&sl=auto&tl=' + encodeURIComponent(this.targetLang)
				+ '&dt=t&q=' + encodeURIComponent(chunks[i]);
			const data = await this._request('GET', url);
			if (!Array.isArray(data) || !Array.isArray(data[0])) {
				throw new Error('Google 返回格式异常');
			}
			out.push(data[0].map(seg => (seg && seg[0]) || '').join(''));
			if (chunks.length > 1 && i < chunks.length - 1) await this.sleep(200);
		}
		const result = out.join('').trim();
		if (!result) throw new Error('Google 未返回译文');
		return result;
	},

	// ---------------------------------------------------------------- MyMemory

	async mymemory(text) {
		const chunks = this._chunk(text, 450);
		const email = (Zotero.Prefs.get('extensions.zhinfo.mymemory.email', true) || '').trim();
		const srcLang = (Zotero.Prefs.get('extensions.zhinfo.mymemory.sourceLang', true) || 'en').trim();
		const out = [];
		for (let i = 0; i < chunks.length; i++) {
			let url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(chunks[i])
				+ '&langpair=' + encodeURIComponent(srcLang + '|' + this.targetLang);
			if (email) url += '&de=' + encodeURIComponent(email);
			const data = await this._request('GET', url);
			const t = data && data.responseData && data.responseData.translatedText;
			if (!t) {
				const msg = (data && data.responseDetails) || '未返回译文';
				throw new Error('MyMemory：' + msg);
			}
			out.push(String(t));
			if (chunks.length > 1 && i < chunks.length - 1) await this.sleep(300);
		}
		return out.join('').trim();
	},

	// ---------------------------------------------------------------- DeepL

	async deepl(text) {
		const key = (Zotero.Prefs.get('extensions.zhinfo.deepl.apiKey', true) || '').trim();
		if (!key) throw new Error('请先在设置中填写 DeepL API Key');
		const free = Zotero.Prefs.get('extensions.zhinfo.deepl.free', true) !== false;
		const endpoint = free
			? 'https://api-free.deepl.com/v2/translate'
			: 'https://api.deepl.com/v2/translate';
		const target = String(this.targetLang).toLowerCase().startsWith('zh-tw') ? 'ZH-HANT' : 'ZH';
		const body = 'text=' + encodeURIComponent(text) + '&target_lang=' + target;
		const data = await this._request('POST', endpoint, {
			headers: {
				'Authorization': 'DeepL-Auth-Key ' + key,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body,
		});
		const t = data && data.translations && data.translations[0] && data.translations[0].text;
		if (!t) throw new Error('DeepL 返回格式异常');
		return String(t).trim();
	},

	// ---------------------------------------------------------------- LLM

	async llm(text, kind) {
		const base = (Zotero.Prefs.get('extensions.zhinfo.llm.baseURL', true) || '').trim().replace(/\/+$/, '');
		const key = (Zotero.Prefs.get('extensions.zhinfo.llm.apiKey', true) || '').trim();
		const model = (Zotero.Prefs.get('extensions.zhinfo.llm.model', true) || '').trim();
		if (!base) throw new Error('请先在设置中填写大模型接口地址（Base URL）');
		if (!model) throw new Error('请先在设置中填写模型名称');

		const url = /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
		const langName = String(this.targetLang).toLowerCase().startsWith('zh-tw')
			? '繁体中文（台湾用语）'
			: '简体中文';
		const extra = (Zotero.Prefs.get(
			'extensions.zhinfo.llm.' + (kind === 'abstract' ? 'abstractPrompt' : 'titlePrompt'), true) || ''
		).trim();

		const system = kind === 'abstract'
			? '你是一名学术文献翻译专家。请把用户提供的文献摘要翻译成' + langName
				+ '，要求：忠实通顺、术语准确、保留必要缩写与专有名词，不增删内容，'
				+ '不要输出原文、解释、标题或任何前后缀，只输出译文本身。'
			: '你是一名学术文献翻译专家。请把用户提供的文献标题翻译成' + langName
				+ '，要求：准确简洁、符合中文学术期刊标题习惯，只输出译文本身，'
				+ '不要输出引号、原文或任何解释。';

		const headers = { 'Content-Type': 'application/json' };
		if (key) headers['Authorization'] = 'Bearer ' + key;

		const payload = {
			model,
			messages: [
				{ role: 'system', content: system + (extra ? '\n' + extra : '') },
				{ role: 'user', content: text },
			],
			temperature: 0.2,
			stream: false,
		};

		let data;
		try {
			data = await this._request('POST', url, { headers, body: JSON.stringify(payload) });
		}
		catch (e) {
			// 部分推理类模型不接受 temperature，去掉后重试一次
			if (/temperature/i.test(String(e && e.message))) {
				delete payload.temperature;
				data = await this._request('POST', url, { headers, body: JSON.stringify(payload) });
			}
			else {
				throw e;
			}
		}

		const choice = data && data.choices && data.choices[0];
		let out = choice && choice.message && choice.message.content;
		if (Array.isArray(out)) {
			// 少数兼容实现返回分段内容
			out = out.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
		}
		if (!out && choice && choice.text) out = choice.text;
		if (!out) {
			throw new Error('大模型返回格式异常：' + JSON.stringify(data).slice(0, 200));
		}
		return this._clean(out);
	},

	_clean(s) {
		let t = String(s).trim();
		t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
		t = t.replace(/^(译文|翻译|中文标题|中文摘要)\s*[:：]\s*/, '').trim();
		if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
			t = t.slice(1, -1).trim();
		}
		return t;
	},
};
