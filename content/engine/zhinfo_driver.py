"""zhinfo 引擎驱动：按 BabelDOC 官方 main.py 的用法调用 async_translate，
以 JSONL 输出结构化进度（解决非 TTY 下 rich 进度条静默、外部读不到任何输出的问题）。
用法：python zhinfo_driver.py --input X.pdf --output DIR --pages 1-3 --lang-in en --lang-out zh-CN
       --model M --base-url U --api-key K [--thinking disabled] [--qps N] [--skip-scanned] [--report-interval 2]
"""
import argparse, asyncio, json, os, sys, threading, traceback


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def build_config(a):
    from babeldoc.format.pdf.translation_config import TranslationConfig
    from babeldoc.translator import translator
    # 与 BabelDOC main.py 一致：默认走本地 ONNX 版面模型
    from babeldoc.docvision.doclayout import DocLayoutModel
    emit({"type": "stage", "stage": "loading_layout_model"})
    doc_layout_model = DocLayoutModel.load_onnx()

    t = translator.OpenAITranslator(
        lang_in=a.lang_in, lang_out=a.lang_out, model=a.model,
        base_url=a.base_url, api_key=a.api_key, ignore_cache=False,
    )
    if a.thinking and a.thinking in ("enabled", "disabled"):
        t.extra_body["thinking"] = {"type": a.thinking}
        t.add_cache_impact_parameters("thinking", a.thinking)

    # TranslationConfig.parse_pages 接受字符串（"1"、"1-3"、"1,3,5"），不要传 list
    pages = None if (not a.pages or a.pages == "all") else a.pages

    os.makedirs(a.output, exist_ok=True)
    cfg = TranslationConfig(
        input_file=a.input,
        font=None,
        pages=pages,
        doc_layout_model=doc_layout_model,
        output_dir=a.output,
        translator=t,
        term_extraction_translator=None,
        debug=False,
        lang_in=a.lang_in,
        lang_out=a.lang_out,
        no_dual=False,
        no_mono=False,
        qps=a.qps,
        report_interval=a.report_interval,
        skip_scanned_detection=a.skip_scanned,
        watermark_output_mode="no_watermark",
    )
    return cfg


def pick_source_pdf(path):
    """若传入的是 BabelDOC/PDFMathTranslate 生成的产物，尝试找到同目录的原始 PDF。
    参考 BabelDOC 自身的检测：它拒绝翻译已由它生成的文件。"""
    import re
    name = os.path.basename(path)
    if not re.search(r"\.(no_watermark\.)?(zh|zh-CN|zh-TW)(\.[a-z\-]+)?\.(mono|dual)\.pdf$", name, re.I):
        return path, None
    d, base = os.path.split(path)
    # 去掉 .no_watermark.zh-CN.dual / .zh-CN.dual 之类的后缀
    stem = re.sub(r"\.(no_watermark\.)?(zh|zh-CN|zh-TW)(\.[a-z\-]+)?\.(mono|dual)\.pdf$", "", base, flags=re.I)
    for cand in (stem + ".pdf",):
        p = os.path.join(d, cand)
        if os.path.exists(p):
            return p, path
    # 同目录下找“最像原始文件”的 pdf（名字前缀相同、不是产物）
    pref = stem[:40].lower()
    best = None
    for fn in os.listdir(d):
        if not fn.lower().endswith(".pdf"):
            continue
        if re.search(r"\.(mono|dual)\.pdf$", fn, re.I):
            continue
        if fn.lower().startswith(pref) or pref.startswith(fn.lower()[:40]):
            if best is None or len(fn) < len(best):
                best = fn
    if best:
        return os.path.join(d, best), path
    return path, path


async def run(a):
    from babeldoc.format.pdf import high_level
    src, was = pick_source_pdf(a.input)
    if was:
        emit({"type": "stage", "stage": "using_original", "note": os.path.basename(src)})
        emit({"type": "progress", "stage": "已自动改用原始 PDF（当前打开的是翻译产物）", "cur": 1, "total": 1, "pct": 0, "done": True})
        a.input = src
    cfg = build_config(a)
    emit({"type": "stage", "stage": "config_ready"})
    async for event in high_level.async_translate(cfg):
        et = event.get("type")
        if et == "progress_update" or et == "progress_end":
            emit({"type": "progress", "stage": event.get("stage"),
                  "cur": event.get("stage_current"), "total": event.get("stage_total"),
                  "pct": event.get("overall_progress"), "done": et == "progress_end"})
        elif et == "progress_start":
            emit({"type": "progress", "stage": event.get("stage"), "cur": 0,
                  "total": event.get("stage_total"), "pct": 0, "done": False})
        elif et == "error":
            emit({"type": "error", "error": str(event.get("error"))})
            return
        elif et == "finish":
            r = event.get("translate_result")
            emit({"type": "finish",
                  "mono": str(getattr(r, "mono_pdf_path", "") or ""),
                  "dual": str(getattr(r, "dual_pdf_path", "") or ""),
                  "seconds": getattr(r, "total_seconds", None)})
            return
    emit({"type": "error", "error": "engine finished without result"})


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--pages", default="all")
    p.add_argument("--lang-in", default="en")
    p.add_argument("--lang-out", default="zh-CN")
    p.add_argument("--model", required=True)
    p.add_argument("--base-url", required=True)
    p.add_argument("--api-key", required=True)
    p.add_argument("--thinking", default="")
    p.add_argument("--qps", type=int, default=2)
    p.add_argument("--report-interval", type=float, default=2)
    p.add_argument("--skip-scanned", action="store_true")
    a = p.parse_args()
    emit({"type": "stage", "stage": "starting"})
    try:
        asyncio.run(run(a))
    except BaseException as e:
        emit({"type": "error", "error": f"{type(e).__name__}: {e}"})
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()