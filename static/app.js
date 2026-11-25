const fileInput = document.getElementById('fileInput');
const dropzone = document.getElementById('dropzone');
const filePreview = document.getElementById('filePreview');
const analyzeBtn = document.getElementById('analyzeBtn');
const confidence = document.getElementById('confidence');
const tableSearch = document.getElementById('tableSearch');
const clearSavedBtn = document.getElementById('clearSavedBtn');

const STORAGE_KEY = 'workvision_saved_scan_v1';

// قائمة أدوات السلامة المعتمدة في النموذج للمقارنة بعدد الأشخاص
const KNOWN_PPE_CLASSES = ['Helmet', 'gloves', 'Safety_Vest', 'Safety_Harness', 'goggles'];

const CATEGORY_IMAGE_FALLBACKS = new Map();

let selectedFile = null;
let currentObjectUrl = null;
let latestDetections = [];
let activeFilter = 'all';

function setFile(file) {
  if (!file) return;
  const allowed = /\.(jpg|jpeg|png|webp|bmp|mp4|mov|avi|mkv)$/i;
  if (!allowed.test(file.name)) {
    alert('صيغة الملف غير مدعومة.');
    return;
  }
  selectedFile = file;
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB';
  filePreview.hidden = false;
  analyzeBtn.disabled = false;
  document.getElementById('previewState').textContent = 'جاهز للتحليل';

  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(file);

  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|avi|mkv)$/i.test(file.name);
  document.getElementById('previewStage').innerHTML = isVideo
    ? `<video controls src="${currentObjectUrl}"></video>`
    : `<img src="${currentObjectUrl}" alt="معاينة الملف">`;
}

fileInput.addEventListener('change', (e) => setFile(e.target.files[0]));

document.getElementById('removeFile').onclick = () => {
  selectedFile = null;
  fileInput.value = '';
  filePreview.hidden = true;
  analyzeBtn.disabled = true;
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  document.getElementById('previewStage').innerHTML = `
    <div class="empty-preview">
      <div class="empty-art">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      </div>
      <strong>لا توجد وسائط معروضة حالياً</strong>
      <small>ستظهر هنا المعاينة الأصلية ثم النتائج المرسومة بإطارات التحديد</small>
    </div>`;
  document.getElementById('previewState').textContent = 'بانتظار رفع الملف';
};

['dragenter', 'dragover'].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  });
});

['dragleave', 'drop'].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
  });
});

dropzone.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));

confidence.addEventListener('input', () => {
  document.getElementById('confidenceValue').textContent = confidence.value + '%';
});

const navPills = [...document.querySelectorAll('.nav-pill')];
const trackedSections = navPills
  .map((pill) => document.querySelector(pill.getAttribute('href')))
  .filter(Boolean);

window.addEventListener(
  'scroll',
  () => {
    const pos = window.scrollY + 130;
    let current = trackedSections[0]?.id;
    for (const sec of trackedSections) {
      if (sec.offsetTop <= pos) current = sec.id;
    }
    navPills.forEach((p) => p.classList.toggle('active', p.getAttribute('href') === `#${current}`));
  },
  { passive: true }
);

function updateModelBadge(id, exists) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = exists ? 'جاهز' : 'مفقود';
  el.classList.toggle('missing', !exists);
}

async function checkHealth() {
  const statusEl = document.getElementById('engineStatus');
  const stateBadge = document.getElementById('systemState');

  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    const models = d.models || {};
    const ok = Object.values(models).every((x) => x && x.exists);

    statusEl.textContent = ok ? 'النماذج الثلاثة متصلة' : 'بعض ملفات النماذج مفقودة';
    stateBadge.classList.toggle('offline', !ok);

    if (models.hazard) updateModelBadge('modelStatusHazard', Boolean(models.hazard.exists));
    if (models.ppe) updateModelBadge('modelStatusPpe', Boolean(models.ppe.exists));
    if (models.person) updateModelBadge('modelStatusPerson', Boolean(models.person.exists));
  } catch (e) {
    statusEl.textContent = 'تعذر الاتصال بالخادم';
    stateBadge.classList.add('offline');
  }
}
checkHealth();

analyzeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  const selected = [...document.querySelectorAll('.model-tile input:checked')].map((x) => x.value);
  if (!selected.length) {
    alert('اختر نموذجًا واحدًا على الأقل.');
    return;
  }

  const fd = new FormData();
  fd.append('file', selectedFile);
  fd.append('models', selected.length === 3 ? 'all' : selected.join(','));
  fd.append('confidence', Number(confidence.value) / 100);

  analyzeBtn.disabled = true;
  document.getElementById('progressWrap').hidden = false;
  document.getElementById('progressText').textContent = 'جارٍ رفع الملف وتشغيل محركات الرؤية...';

  let p = 6;
  const bar = document.getElementById('progressBar');
  const pct = document.getElementById('progressPercent');
  const timer = setInterval(() => {
    p = Math.min(p + Math.random() * 7, 92);
    bar.style.width = p + '%';
    pct.textContent = Math.round(p) + '%';
  }, 450);

  try {
    const response = await fetch('/api/analyze', { method: 'POST', body: fd });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'فشل التحليل');

    clearInterval(timer);
    bar.style.width = '100%';
    pct.textContent = '100%';
    document.getElementById('progressText').textContent = 'اكتمل التحليل وحُفظ محليًا';
    saveScanLocally(data);
    renderResults(data, { shouldScroll: true, isRestored: false });
  } catch (err) {
    clearInterval(timer);
    document.getElementById('progressText').textContent = 'تعذر إكمال التحليل';
    alert(err.message);
  } finally {
    analyzeBtn.disabled = false;
  }
});

function resolveImageSlug(name, kind = 'ppe') {
  const s = String(name || '').toLowerCase();
  if (s.includes('helmet')) return 'helmet';
  if (s.includes('glove')) return 'gloves';
  if (s.includes('vest')) return 'safety_vest';
  if (s.includes('harness')) return 'safety_harness';
  if (s.includes('goggle') || s.includes('glass')) return 'goggles';
  if (s.includes('fire') || s.includes('flame') || s.includes('smoke')) return 'fire';
  if (kind === 'hazard') return 'hazard';
  return 'ppe';
}

function createRasterFallbackPng(slug, kind = 'ppe', isMissing = false) {
  const key = `${slug}|${kind}|${isMissing ? 1 : 0}`;
  if (CATEGORY_IMAGE_FALLBACKS.has(key)) {
    return CATEGORY_IMAGE_FALLBACKS.get(key);
  }

  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const isHazardStyle = kind === 'hazard' || isMissing;
  ctx.fillStyle = isHazardStyle ? '#fffbeb' : '#ecfdf5';
  ctx.fillRect(0, 0, 96, 96);

  ctx.strokeStyle = isHazardStyle ? '#f59e0b' : '#10b981';
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, 88, 88);

  const mainColor = isHazardStyle ? '#b45309' : '#047857';
  const accentColor = isHazardStyle ? '#f59e0b' : '#34d399';
  ctx.fillStyle = mainColor;
  ctx.strokeStyle = mainColor;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (slug === 'helmet') {
    ctx.beginPath();
    ctx.arc(48, 52, 24, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(18, 52, 60, 8);
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(48, 30);
    ctx.lineTo(48, 50);
    ctx.stroke();
  } else if (slug === 'safety_vest') {
    ctx.beginPath();
    ctx.moveTo(35, 22);
    ctx.lineTo(61, 22);
    ctx.lineTo(74, 38);
    ctx.lineTo(74, 74);
    ctx.lineTo(22, 74);
    ctx.lineTo(22, 38);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#fde047';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(24, 56);
    ctx.lineTo(72, 56);
    ctx.moveTo(24, 65);
    ctx.lineTo(72, 65);
    ctx.stroke();
  } else if (slug === 'safety_harness') {
    ctx.strokeRect(24, 22, 48, 52);
    ctx.beginPath();
    ctx.moveTo(34, 24);
    ctx.lineTo(48, 48);
    ctx.lineTo(62, 24);
    ctx.moveTo(48, 48);
    ctx.lineTo(48, 72);
    ctx.moveTo(24, 48);
    ctx.lineTo(72, 48);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(48, 48, 6, 0, Math.PI * 2);
    ctx.fill();
  } else if (slug === 'gloves') {
    ctx.beginPath();
    ctx.roundRect(28, 36, 40, 38, 12);
    ctx.fill();
    ctx.fillRect(30, 20, 8, 20);
    ctx.fillRect(42, 16, 8, 24);
    ctx.fillRect(54, 18, 8, 22);
    ctx.fillRect(64, 24, 8, 22);
  } else if (slug === 'goggles') {
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.roundRect(16, 36, 28, 24, 8);
    ctx.roundRect(52, 36, 28, 24, 8);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(44, 46);
    ctx.lineTo(52, 46);
    ctx.moveTo(8, 46);
    ctx.lineTo(16, 46);
    ctx.moveTo(80, 46);
    ctx.lineTo(88, 46);
    ctx.stroke();
  } else if (slug === 'fire') {
    ctx.beginPath();
    ctx.moveTo(48, 18);
    ctx.bezierCurveTo(66, 34, 70, 50, 62, 66);
    ctx.bezierCurveTo(54, 76, 34, 75, 28, 62);
    ctx.bezierCurveTo(23, 50, 32, 38, 38, 32);
    ctx.bezierCurveTo(37, 41, 43, 44, 47, 38);
    ctx.bezierCurveTo(50, 32, 46, 24, 48, 18);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(48, 20);
    ctx.lineTo(74, 68);
    ctx.lineTo(22, 68);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(48, 36);
    ctx.lineTo(48, 52);
    ctx.stroke();
  }

  if (isMissing) {
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.arc(76, 20, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(71, 15);
    ctx.lineTo(81, 25);
    ctx.moveTo(81, 15);
    ctx.lineTo(71, 25);
    ctx.stroke();
  }

  const url = canvas.toDataURL('image/png');
  CATEGORY_IMAGE_FALLBACKS.set(key, url);
  return url;
}

function getCategoryPhotoHtml(name, kind = 'ppe', isMissing = false) {
  const slug = resolveImageSlug(name, kind);
  const localSrc = `/static/images/categories/${slug}.png`;
  const fallbackSrc = createRasterFallbackPng(slug, kind, isMissing);
  const altText = escapeHtml(name || slug);

  return `
    <span class="cat-photo-wrap ${kind === 'hazard' ? 'is-hazard' : 'is-ppe'} ${isMissing ? 'is-missing' : ''}">
      <img
        class="cat-photo-img"
        src="${localSrc}"
        data-fallback="${escapeHtml(fallbackSrc)}"
        alt="${altText}"
        loading="lazy"
        onerror="if(this.dataset.fallback && this.src !== this.dataset.fallback){this.src=this.dataset.fallback;}"
      >
    </span>`;
}

function detectRawCategory(item) {
  const c = String(item.class_name || '').trim().toLowerCase();
  const m = String(item.model_name || item.model || '').trim().toLowerCase();

  if (c === 'person' || c === 'worker' || m.includes('person') || m.includes('أشخاص')) {
    return 'person';
  }

  if (
    c.startsWith('no_') ||
    c.startsWith('no-') ||
    c.includes('without') ||
    c.includes('missing') ||
    c.includes('fire') ||
    c.includes('smoke')
  ) {
    return 'explicit_hazard';
  }

  return 'ppe';
}

function groupPpeClasses(detections, peopleCount) {
  const map = new Map();

  for (const item of detections) {
    if (detectRawCategory(item) !== 'ppe') continue;
    const rawName = String(item.class_name || 'Unknown').trim();
    const conf = Number(item.confidence) || 0;
    if (!map.has(rawName)) {
      map.set(rawName, { rawName, count: 0, sumConf: 0 });
    }
    const g = map.get(rawName);
    g.count += 1;
    g.sumConf += conf;
  }

  const totalPpeDetections = [...map.values()].reduce((s, x) => s + x.count, 0);

  return [...map.values()]
    .map((g) => {
      const share =
        peopleCount > 0
          ? Math.min(100, Math.round((g.count / peopleCount) * 100))
          : totalPpeDetections > 0
            ? Math.round((g.count / totalPpeDetections) * 100)
            : 0;
      const avgConf = g.count > 0 ? ((g.sumConf / g.count) * 100).toFixed(1) : '0.0';
      return { ...g, share, avgConf };
    })
    .sort((a, b) => b.count - a.count);
}

function computeDerivedHazards(detections, peopleCount) {
  const map = new Map();
  const ppeTypeCounts = new Map();

  for (const item of detections) {
    const cat = detectRawCategory(item);
    const rawName = String(item.class_name || 'Unknown').trim();
    const conf = Number(item.confidence) || 0;

    if (cat === 'explicit_hazard') {
      if (!map.has(rawName)) {
        map.set(rawName, { rawName, count: 0, sumConf: 0, isMissingGap: false });
      }
      const g = map.get(rawName);
      g.count += 1;
      g.sumConf += conf;
    } else if (cat === 'ppe') {
      ppeTypeCounts.set(rawName, (ppeTypeCounts.get(rawName) || 0) + 1);
    }
  }

  if (peopleCount > 0) {
    const candidateNames = new Set([
      ...ppeTypeCounts.keys(),
      ...KNOWN_PPE_CLASSES
    ]);

    for (const ppeName of candidateNames) {
      const detectedCount = ppeTypeCounts.get(ppeName) || 0;
      if (detectedCount < peopleCount) {
        const missingCount = peopleCount - detectedCount;
        const missingLabel = `Missing ${ppeName}`;
        map.set(missingLabel, {
          rawName: missingLabel,
          count: missingCount,
          sumConf: 0,
          isMissingGap: true
        });
      }
    }
  }

  const totalHazards = [...map.values()].reduce((s, x) => s + x.count, 0);

  return [...map.values()]
    .map((g) => {
      const share =
        peopleCount > 0
          ? Math.min(100, Math.round((g.count / peopleCount) * 100))
          : totalHazards > 0
            ? Math.round((g.count / totalHazards) * 100)
            : 0;
      return { ...g, share };
    })
    .sort((a, b) => b.count - a.count);
}

function renderClassBreakdowns(detections, peopleCount) {
  const hazardGroups = computeDerivedHazards(detections, peopleCount);
  const ppeGroups = groupPpeClasses(detections, peopleCount);

  const totalDerivedHazards = hazardGroups.reduce((s, x) => s + x.count, 0);
  const totalPpe = ppeGroups.reduce((s, x) => s + x.count, 0);

  const totalAll = peopleCount + totalDerivedHazards + totalPpe;
  const pct = (v) => (totalAll > 0 ? `${Math.round((v / totalAll) * 100)}%` : '0%');

  document.getElementById('totalCount').textContent = totalAll;
  document.getElementById('peopleCount').textContent = peopleCount;
  document.getElementById('hazardCount').textContent = totalDerivedHazards;
  document.getElementById('ppeCount').textContent = totalPpe;

  document.getElementById('totalRatioBadge').textContent = totalAll > 0 ? '100%' : '0%';
  document.getElementById('peopleRatioBadge').textContent = pct(peopleCount);
  document.getElementById('hazardRatioBadge').textContent = pct(totalDerivedHazards);
  document.getElementById('ppeRatioBadge').textContent = pct(totalPpe);

  const hazardMiniEl = document.getElementById('hazardTypesMini');
  if (!hazardGroups.length) {
    hazardMiniEl.innerHTML = '<span class="kpi-foot">لا توجد مخاطر أو نقص مسجل</span>';
  } else {
    hazardMiniEl.innerHTML = hazardGroups
      .map(
        (g) =>
          `<span class="mini-tag amber">${getCategoryPhotoHtml(g.rawName, 'hazard', g.isMissingGap)}<span>${escapeHtml(g.rawName)} (${g.count} · ${g.share}%)</span></span>`
      )
      .join('');
  }

  const ppeMiniEl = document.getElementById('ppeTypesMini');
  if (!ppeGroups.length) {
    ppeMiniEl.innerHTML = '<span class="kpi-foot">لم يتم رصد معدات وقاية</span>';
  } else {
    ppeMiniEl.innerHTML = ppeGroups
      .map(
        (g) =>
          `<span class="mini-tag emerald">${getCategoryPhotoHtml(g.rawName, 'ppe', false)}<span>${escapeHtml(g.rawName)} (${g.count} · ${g.share}%)</span></span>`
      )
      .join('');
  }

  document.getElementById('hazardUniqueTag').textContent = `${hazardGroups.length} نوع`;
  document.getElementById('ppeUniqueTag').textContent = `${ppeGroups.length} نوع`;

  const hazardListEl = document.getElementById('hazardBreakdownList');
  if (!hazardGroups.length) {
    hazardListEl.innerHTML =
      '<div class="chart-empty">لا توجد مخاطر أو نقص في الفحص الحالي.</div>';
  } else {
    hazardListEl.innerHTML = hazardGroups
      .map((g) => {
        const confText =
          !g.isMissingGap && g.sumConf > 0
            ? ` · Conf ${((g.sumConf / g.count) * 100).toFixed(1)}%`
            : peopleCount > 0
              ? ` · ${g.count} من ${peopleCount}`
              : '';
        return `
          <div class="class-item">
            <div class="class-item-top">
              <div class="class-item-name">
                ${getCategoryPhotoHtml(g.rawName, 'hazard', g.isMissingGap)}
                <strong dir="ltr">${escapeHtml(g.rawName)}</strong>
              </div>
              <div class="class-item-stats">${g.count} <span>(${g.share}%${confText})</span></div>
            </div>
            <div class="dist-track">
              <div class="dist-fill fill-amber" style="width:${g.share}%"></div>
            </div>
          </div>`;
      })
      .join('');
  }

  const ppeListEl = document.getElementById('ppeBreakdownList');
  if (!ppeGroups.length) {
    ppeListEl.innerHTML =
      '<div class="chart-empty">لم يتم رصد معدات وقاية في الفحص الحالي.</div>';
  } else {
    ppeListEl.innerHTML = ppeGroups
      .map((g) => {
        const extraText =
          peopleCount > 0
            ? `${g.count} من ${peopleCount} · Conf ${g.avgConf}%`
            : `Conf ${g.avgConf}%`;
        return `
          <div class="class-item">
            <div class="class-item-top">
              <div class="class-item-name">
                ${getCategoryPhotoHtml(g.rawName, 'ppe', false)}
                <strong dir="ltr">${escapeHtml(g.rawName)}</strong>
              </div>
              <div class="class-item-stats">${g.count} <span>(${g.share}% · ${extraText})</span></div>
            </div>
            <div class="dist-track">
              <div class="dist-fill fill-emerald" style="width:${g.share}%"></div>
            </div>
          </div>`;
      })
      .join('');
  }

  return { totalAll, totalDerivedHazards, totalPpe };
}

function renderDistribution(peopleCount, hazardsCount, ppeCount, totalAll) {
  const chart = document.getElementById('distributionChart');
  document.getElementById('donutTotal').textContent = totalAll;
  document.getElementById('analyticsTotalTag').textContent = `${totalAll} عنصر`;

  const C = 339.29;
  const pLen = totalAll > 0 ? (peopleCount / totalAll) * C : 0;
  const hLen = totalAll > 0 ? (hazardsCount / totalAll) * C : 0;
  const eLen = totalAll > 0 ? (ppeCount / totalAll) * C : 0;

  const segPeople = document.getElementById('segPeople');
  const segHazard = document.getElementById('segHazard');
  const segPpe = document.getElementById('segPpe');

  segPeople.setAttribute('stroke-dasharray', `${pLen} ${C}`);
  segPeople.setAttribute('stroke-dashoffset', '0');

  segHazard.setAttribute('stroke-dasharray', `${hLen} ${C}`);
  segHazard.setAttribute('stroke-dashoffset', `${-pLen}`);

  segPpe.setAttribute('stroke-dasharray', `${eLen} ${C}`);
  segPpe.setAttribute('stroke-dashoffset', `${-(pLen + hLen)}`);

  const items = [
    { label: 'Persons', value: peopleCount, fill: 'fill-blue' },
    { label: 'Hazards', value: hazardsCount, fill: 'fill-amber' },
    { label: 'PPE', value: ppeCount, fill: 'fill-emerald' }
  ];

  chart.innerHTML = items
    .map((item) => {
      const ratio = totalAll > 0 ? Math.round((item.value / totalAll) * 100) : 0;
      return `
        <div class="dist-row">
          <div class="dist-row-head">
            <span dir="ltr">${item.label}</span>
            <strong>${item.value} (${ratio}%)</strong>
          </div>
          <div class="dist-track">
            <div class="dist-fill ${item.fill}" style="width:${ratio}%"></div>
          </div>
        </div>`;
    })
    .join('');
}

function renderStatistics(peopleCount, hazardsCount, ppeCount, totalAll, detections) {
  const confs = (detections || [])
    .map((x) => Number(x.confidence))
    .filter((n) => Number.isFinite(n));

  const avgConf = confs.length
    ? ((confs.reduce((a, b) => a + b, 0) / confs.length) * 100).toFixed(1) + '%'
    : '—';
  const maxConf = confs.length ? (Math.max(...confs) * 100).toFixed(1) + '%' : '—';

  document.getElementById('avgConfidenceStat').textContent = avgConf;
  document.getElementById('maxConfidenceStat').textContent = maxConf;
  document.getElementById('heroAvgConf').textContent = avgConf;

  const hazardRate = totalAll > 0 ? ((hazardsCount / totalAll) * 100).toFixed(1) + '%' : '0%';
  document.getElementById('hazardRateStat').textContent = hazardRate;

  const ppeCoverage =
    peopleCount > 0 ? `${Math.min(100, Math.round((ppeCount / peopleCount) * 100))}%` : ppeCount > 0 ? '100%' : '—';
  document.getElementById('ppeCoverageStat').textContent = ppeCoverage;

  const arc = document.getElementById('safetyGaugeArc');
  const scoreEl = document.getElementById('heroSafetyScore');
  const labelEl = document.getElementById('complianceLabel');
  const C = 314.16;

  if (totalAll === 0) {
    scoreEl.textContent = '--%';
    labelEl.textContent = 'لا توجد اكتشافات';
    arc.setAttribute('stroke-dashoffset', String(C));
    return;
  }

  const hazardPenalty = (hazardsCount / totalAll) * 65;
  const ppeGapPenalty = peopleCount > ppeCount ? Math.min(35, ((peopleCount - ppeCount) / Math.max(1, peopleCount)) * 35) : 0;
  const score = Math.max(0, Math.min(100, Math.round(100 - hazardPenalty - ppeGapPenalty)));

  scoreEl.textContent = `${score}%`;
  const offset = C - (score / 100) * C;
  arc.setAttribute('stroke-dashoffset', offset.toFixed(2));

  if (score >= 80) {
    arc.style.stroke = '#34d399';
    labelEl.textContent = 'امتثال مرتفع وآمن';
  } else if (score >= 50) {
    arc.style.stroke = '#fbbf24';
    labelEl.textContent = 'يتطلب انتباهاً';
  } else {
    arc.style.stroke = '#f87171';
    labelEl.textContent = 'مخاطر مرتفعة';
  }
}

function matchesFilter(item, filter) {
  if (filter === 'all') return true;
  const cat = detectRawCategory(item);
  if (filter === 'hazard') return cat === 'explicit_hazard';
  if (filter === 'ppe') return cat === 'ppe';
  if (filter === 'person') return cat === 'person';
  return true;
}

function renderTable() {
  const rows = document.getElementById('detectionRows');
  const query = (tableSearch?.value || '').trim().toLowerCase();

  const filtered = latestDetections.filter((x) => {
    if (!matchesFilter(x, activeFilter)) return false;
    if (!query) return true;
    return (
      String(x.class_name || '').toLowerCase().includes(query) ||
      String(x.model_name || '').toLowerCase().includes(query)
    );
  });

  if (!latestDetections.length) {
    rows.innerHTML =
      '<tr><td colspan="5" class="empty-row">لم يتم رصد اكتشافات عند حد الثقة المحدد.</td></tr>';
    return;
  }

  if (!filtered.length) {
    rows.innerHTML =
      '<tr><td colspan="5" class="empty-row">لا توجد نتائج مطابقة لخيار التصفية أو البحث الحالي.</td></tr>';
    return;
  }

  rows.innerHTML = filtered
    .map((x) => {
      const box = x.box || [];
      const time = x.time_seconds == null ? '—' : `${x.time_seconds}s (إطار ${x.frame})`;
      const confPct = Math.max(0, Math.min(100, Number(x.confidence || 0) * 100));
      const cat = detectRawCategory(x);
      const badgeCls = cat === 'explicit_hazard' ? 'hazard' : cat === 'ppe' ? 'ppe' : '';
      return `
        <tr>
          <td><span class="model-badge ${badgeCls}">${escapeHtml(x.model_name)}</span></td>
          <td><strong dir="ltr">${escapeHtml(x.class_name)}</strong></td>
          <td><span class="confidence-bar"><i style="width:${confPct}%"></i></span>${confPct.toFixed(1)}%</td>
          <td>${escapeHtml(time)}</td>
          <td><code>${escapeHtml(box.join(', '))}</code></td>
        </tr>`;
    })
    .join('');
}

document.getElementById('filterPills')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  activeFilter = btn.dataset.filter;
  renderTable();
});

tableSearch?.addEventListener('input', renderTable);

function saveScanLocally(data) {
  try {
    const payload = {
      savedAt: new Date().toISOString(),
      data
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    if (clearSavedBtn) clearSavedBtn.hidden = false;
  } catch (e) {}
}

function restoreSavedScan() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.data) return;
    if (clearSavedBtn) clearSavedBtn.hidden = false;
    renderResults(parsed.data, { shouldScroll: false, isRestored: true });
  } catch (e) {}
}

clearSavedBtn?.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  clearSavedBtn.hidden = true;
  location.reload();
});

function renderResults(d, opts = { shouldScroll: true, isRestored: false }) {
  const s = d.summary || {};
  latestDetections = d.detections || [];

  const peopleCount =
    Number(s.people) ||
    latestDetections.filter((x) => detectRawCategory(x) === 'person').length;

  const { totalAll, totalDerivedHazards, totalPpe } = renderClassBreakdowns(
    latestDetections,
    peopleCount
  );

  renderDistribution(peopleCount, totalDerivedHazards, totalPpe, totalAll);
  renderStatistics(peopleCount, totalDerivedHazards, totalPpe, totalAll, latestDetections);

  document.getElementById('previewState').textContent = opts.isRestored
    ? 'مستعاد من الحفظ المحلي'
    : 'اكتمل التحليل';

  const stage = document.getElementById('previewStage');
  if (d.output_url) {
    stage.innerHTML =
      d.media_type === 'video'
        ? `<video controls src="${escapeHtml(d.output_url)}"></video>`
        : `<img src="${escapeHtml(d.output_url)}" alt="الصورة بعد التحليل">`;
  }

  const suffix = opts.isRestored ? ' · محفوظ محليًا' : '';
  document.getElementById('resultCount').textContent =
    `${latestDetections.length} اكتشاف · ${d.original_filename || ''}${suffix}`;
  renderTable();

  if (d.downloads) {
    document.getElementById('pdfLink').href = d.downloads.pdf || '#';
    document.getElementById('csvLink').href = d.downloads.csv || '#';
    document.getElementById('jsonLink').href = d.downloads.json || '#';
    document.getElementById('downloadRow').hidden = false;
  }

  if (opts.shouldScroll) {
    document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

restoreSavedScan();