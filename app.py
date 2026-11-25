import os, uuid, csv, json, shutil, tempfile
from pathlib import Path
from datetime import datetime
from typing import Optional

import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from ultralytics import YOLO
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_RIGHT, TA_CENTER
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image as RLImage
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
try:
    import arabic_reshaper
    from bidi.algorithm import get_display
    ARABIC_SUPPORT = True
except Exception:
    ARABIC_SUPPORT = False

BASE = Path(__file__).resolve().parent
MODEL_DIR = BASE / "models"
OUT_DIR = BASE / "outputs"
UPLOAD_DIR = OUT_DIR / "uploads"
RESULT_DIR = OUT_DIR / "results"
for p in (OUT_DIR, UPLOAD_DIR, RESULT_DIR):
    p.mkdir(parents=True, exist_ok=True)

MODEL_FILES = {
    "hazard": ("نموذج اكتشاف المخاطر", MODEL_DIR / "hazard_detector_yolo11n_classaware.pt"),
    "ppe": ("نموذج معدات الوقاية PPE", MODEL_DIR / "ppe_detector_yolo11n.pt"),
    "person": ("نموذج اكتشاف الأشخاص", MODEL_DIR / "person_detector_augmented.pt"),
}
MODEL_CACHE = {}
DEVICE = os.getenv("DEVICE", "cpu")
DEFAULT_CONF = float(os.getenv("CONFIDENCE", "0.35"))
VIDEO_INTERVAL = float(os.getenv("VIDEO_INTERVAL", "1.0"))

app = FastAPI(title="WorkVision AI", version="1.0.0")
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

def get_model(key):
    if key not in MODEL_FILES:
        raise ValueError("Unknown model")
    if key not in MODEL_CACHE:
        _, path = MODEL_FILES[key]
        if not path.exists():
            raise RuntimeError(f"ملف النموذج غير موجود: {path.name}")
        MODEL_CACHE[key] = YOLO(str(path))
    return MODEL_CACHE[key]

def normalize_names(names):
    if isinstance(names, dict):
        return {int(k): str(v) for k, v in names.items()}
    return {i: str(v) for i, v in enumerate(names or [])}

def run_on_frame(frame, model_keys, conf):
    combined = frame.copy()
    detections = []
    for key in model_keys:
        model = get_model(key)
        results = model.predict(frame, conf=conf, device=DEVICE, verbose=False)
        if not results:
            continue
        result = results[0]
        names = normalize_names(result.names)
        if result.boxes is None:
            continue
        for box in result.boxes:
            xyxy = box.xyxy[0].cpu().numpy().astype(int).tolist()
            cls_id = int(box.cls[0].item())
            confidence = float(box.conf[0].item())
            x1, y1, x2, y2 = xyxy
            label = names.get(cls_id, f"class_{cls_id}")
            detections.append({
                "model": key, "model_name": MODEL_FILES[key][0],
                "class_id": cls_id, "class_name": label,
                "confidence": round(confidence, 4),
                "box": [int(x1), int(y1), int(x2), int(y2)]
            })
            # Distinct palette per model; all boxes remain readable.
            color = {"hazard": (25, 85, 235), "ppe": (25, 180, 130), "person": (220, 145, 30)}[key]
            cv2.rectangle(combined, (x1, y1), (x2, y2), color, 2)
            caption = f"{key.upper()} | {label} {confidence:.0%}"
            (tw, th), _ = cv2.getTextSize(caption, cv2.FONT_HERSHEY_SIMPLEX, 0.52, 2)
            top = max(0, y1 - th - 10)
            cv2.rectangle(combined, (x1, top), (x1 + tw + 8, top + th + 8), color, -1)
            cv2.putText(combined, caption, (x1 + 4, top + th + 2),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.52, (255,255,255), 2)
    return combined, detections

def build_summary(detections):
    by_class, by_model = {}, {}
    for d in detections:
        by_class[d["class_name"]] = by_class.get(d["class_name"], 0) + 1
        by_model[d["model"]] = by_model.get(d["model"], 0) + 1
    return {
        "total": len(detections),
        "people": by_model.get("person", 0),
        "hazards": by_model.get("hazard", 0),
        "ppe": by_model.get("ppe", 0),
        "by_class": by_class,
        "by_model": by_model
    }

def write_csv(path, detections):
    fields = ["model", "model_name", "class_id", "class_name", "confidence", "frame", "time_seconds", "x1", "y1", "x2", "y2"]
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for d in detections:
            b = d.get("box", [None]*4)
            writer.writerow({
                "model": d.get("model"), "model_name": d.get("model_name"),
                "class_id": d.get("class_id"), "class_name": d.get("class_name"),
                "confidence": d.get("confidence"), "frame": d.get("frame"),
                "time_seconds": d.get("time_seconds"),
                "x1": b[0], "y1": b[1], "x2": b[2], "y2": b[3]
            })


def pdf_ar(value):
    value = str(value)
    if ARABIC_SUPPORT:
        return get_display(arabic_reshaper.reshape(value))
    return value

def create_pdf(path, result):
    font_path = BASE / "assets" / "NotoSansArabic-Regular.ttf"
    font_name = "Helvetica"
    if font_path.exists():
        try:
            pdfmetrics.registerFont(TTFont("WorkVisionArabic", str(font_path)))
            font_name = "WorkVisionArabic"
        except Exception:
            pass
    styles = getSampleStyleSheet()
    title = ParagraphStyle("ArabicTitle", parent=styles["Title"], alignment=TA_CENTER,
                           textColor=colors.HexColor("#14243b"), fontSize=17, fontName=font_name)
    normal = ParagraphStyle("Arabic", parent=styles["BodyText"], alignment=TA_RIGHT,
                            fontSize=9, leading=15, fontName=font_name)
    story = [
        Paragraph(pdf_ar("WorkVision AI — تقرير تحليل السلامة المهنية"), title),
        Spacer(1, 8),
        Paragraph(pdf_ar("تاريخ التقرير: " + result["created_at"]), normal),
        Paragraph(pdf_ar("الملف: " + result["original_filename"]), normal),
        Paragraph(pdf_ar("النماذج المستخدمة: " + ", ".join(result["model_labels"])), normal),
        Paragraph(pdf_ar("عتبة الثقة: " + f"{result['confidence']:.0%}"), normal),
        Spacer(1, 10),
    ]
    summary = result["summary"]
    data = [
        [pdf_ar("المؤشر"), pdf_ar("النتيجة")],
        [pdf_ar("إجمالي الاكتشافات"), str(summary["total"])],
        [pdf_ar("اكتشافات نموذج الأشخاص"), str(summary["people"])],
        [pdf_ar("اكتشافات نموذج المخاطر"), str(summary["hazards"])],
        [pdf_ar("اكتشافات نموذج PPE"), str(summary["ppe"])],
    ]
    table = Table(data, colWidths=[260, 120], hAlign="RIGHT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#172b4d")),
        ("TEXTCOLOR", (0,0), (-1,0), colors.white),
        ("GRID", (0,0), (-1,-1), .4, colors.HexColor("#d8e0ea")),
        ("ALIGN", (0,0), (-1,-1), "CENTER"),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#f3f6fa")]),
        ("FONTNAME", (0,0), (-1,-1), font_name),
        ("BOTTOMPADDING", (0,0), (-1,-1), 8),
        ("TOPPADDING", (0,0), (-1,-1), 8),
    ]))
    story += [table, Spacer(1, 12), Paragraph(pdf_ar("تفاصيل الفئات المكتشفة"), normal)]
    rows = [[pdf_ar("الفئة"), pdf_ar("عدد الاكتشافات")]]
    rows += [[pdf_ar(k), str(v)] for k, v in summary["by_class"].items()]
    if len(rows) == 1:
        rows.append([pdf_ar("لا توجد اكتشافات"), "0"])
    table2 = Table(rows, colWidths=[260, 120], hAlign="RIGHT")
    table2.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#e8eef6")),
        ("GRID", (0,0), (-1,-1), .4, colors.HexColor("#d8e0ea")),
        ("ALIGN", (0,0), (-1,-1), "CENTER"),
        ("FONTNAME", (0,0), (-1,-1), font_name),
        ("BOTTOMPADDING", (0,0), (-1,-1), 7),
        ("TOPPADDING", (0,0), (-1,-1), 7),
    ]))
    story += [
        table2, Spacer(1, 14),
        Paragraph(pdf_ar("تنبيه: نتائج الذكاء الاصطناعي استرشادية، ويجب مراجعة الحالات المهمة من مسؤول السلامة."), normal)
    ]
    doc = SimpleDocTemplate(str(path), pagesize=A4, rightMargin=42, leftMargin=42,
                           topMargin=42, bottomMargin=42)
    doc.build(story)

@app.get("/")
def home():
    return FileResponse(BASE / "static" / "index.html")

@app.get("/api/health")
def health():
    return {"status": "ok", "models": {k: {"label": v[0], "exists": v[1].exists(), "loaded": k in MODEL_CACHE} for k,v in MODEL_FILES.items()}}

@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...), models: str = Form("all"), confidence: float = Form(DEFAULT_CONF)):
    if not file.filename:
        raise HTTPException(400, "لم يتم اختيار ملف")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".mp4", ".mov", ".avi", ".mkv"}:
        raise HTTPException(400, "صيغة الملف غير مدعومة")
    if not 0.05 <= confidence <= 0.99:
        raise HTTPException(400, "قيمة الثقة يجب أن تكون بين 0.05 و0.99")
    keys = list(MODEL_FILES) if models == "all" else [x.strip() for x in models.split(",") if x.strip()]
    if not keys or any(k not in MODEL_FILES for k in keys):
        raise HTTPException(400, "اختيار نموذج غير صالح")
    job_id = uuid.uuid4().hex[:12]
    source_path = UPLOAD_DIR / f"{job_id}{suffix}"
    with source_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    is_video = suffix in {".mp4", ".mov", ".avi", ".mkv"}
    all_detections, preview_url, output_url, video_meta = [], None, None, None

    try:
        if not is_video:
            frame = cv2.imread(str(source_path))
            if frame is None:
                raise HTTPException(400, "تعذر قراءة الصورة")
            annotated, detections = run_on_frame(frame, keys, confidence)
            all_detections = detections
            image_path = RESULT_DIR / f"{job_id}_annotated.jpg"
            cv2.imwrite(str(image_path), annotated)
            preview_url = f"/files/{image_path.name}"
            output_url = preview_url
        else:
            cap = cv2.VideoCapture(str(source_path))
            if not cap.isOpened():
                raise HTTPException(400, "تعذر فتح الفيديو")
            fps = cap.get(cv2.CAP_PROP_FPS) or 25
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            duration = frame_count / fps if fps else 0
            interval_frames = max(1, int(fps * VIDEO_INTERVAL))
            out_path = RESULT_DIR / f"{job_id}_annotated.mp4"
            writer = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
            frame_index, sampled = 0, 0
            last_annotated = None
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if frame_index % interval_frames == 0:
                    annotated, detections = run_on_frame(frame, keys, confidence)
                    seconds = frame_index / fps if fps else 0
                    for d in detections:
                        d["frame"] = frame_index
                        d["time_seconds"] = round(seconds, 2)
                    all_detections.extend(detections)
                    last_annotated = annotated
                    sampled += 1
                # Save original frames with sampled annotations; unsampled frames remain original.
                writer.write(last_annotated if (frame_index % interval_frames == 0 and last_annotated is not None) else frame)
                frame_index += 1
            cap.release()
            writer.release()
            if last_annotated is not None:
                thumb = RESULT_DIR / f"{job_id}_preview.jpg"
                cv2.imwrite(str(thumb), last_annotated)
                preview_url = f"/files/{thumb.name}"
            output_url = f"/files/{out_path.name}"
            video_meta = {"duration_seconds": round(duration,2), "fps": round(fps,2), "frames": frame_count, "sampled_frames": sampled, "interval_seconds": VIDEO_INTERVAL}
        if not is_video:
            for d in all_detections:
                d["frame"], d["time_seconds"] = None, None

        summary = build_summary(all_detections)
        result = {
            "job_id": job_id, "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "original_filename": file.filename, "media_type": "video" if is_video else "image",
            "model_keys": keys, "model_labels": [MODEL_FILES[k][0] for k in keys],
            "confidence": confidence, "summary": summary, "detections": all_detections,
            "preview_url": preview_url, "output_url": output_url, "video_meta": video_meta
        }
        json_path = RESULT_DIR / f"{job_id}.json"
        json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        csv_path = RESULT_DIR / f"{job_id}.csv"
        pdf_path = RESULT_DIR / f"{job_id}.pdf"
        write_csv(csv_path, all_detections)
        create_pdf(pdf_path, result)
        result["downloads"] = {"json": f"/files/{json_path.name}", "csv": f"/files/{csv_path.name}", "pdf": f"/files/{pdf_path.name}"}
        return JSONResponse(result)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"حدث خطأ أثناء التحليل: {str(e)}")

@app.get("/files/{filename}")
def get_file(filename: str):
    target = (RESULT_DIR / filename).resolve()
    if RESULT_DIR.resolve() not in target.parents or not target.is_file():
        raise HTTPException(404, "الملف غير موجود")
    return FileResponse(target)
