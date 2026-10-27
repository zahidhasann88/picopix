import {
  canEncode,
  createImageWorker,
  compressImage,
  generatePlaceholder,
  generateSrcSet,
  getImageInfo,
  stripMetadata,
} from 'picopix';

const els = {
  dropzone: document.getElementById('dropzone'),
  file: document.getElementById('file'),
  status: document.getElementById('status'),
  result: document.getElementById('result'),
  original: document.getElementById('original'),
  processed: document.getElementById('processed'),
  originalMeta: document.getElementById('originalMeta'),
  processedMeta: document.getElementById('processedMeta'),
  download: document.getElementById('download'),
  maxEdge: document.getElementById('maxEdge'),
  format: document.getElementById('format'),
  maxSizeKB: document.getElementById('maxSizeKB'),
  sharpen: document.getElementById('sharpen'),
  strip: document.getElementById('strip'),
  placeholder: document.getElementById('placeholder'),
  placeholderMeta: document.getElementById('placeholderMeta'),
  variants: document.getElementById('variants'),
};

const worker = createImageWorker();

/** Recreated whenever a new image is processed, so the previous run can cancel. */
let controller = null;
const objectUrls = [];

function setStatus(message, kind = '') {
  els.status.textContent = message;
  els.status.className = `status ${kind}`.trim();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function trackUrl(url) {
  objectUrls.push(url);
  return url;
}

function releaseUrls() {
  while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop());
}

function mimeFor(format) {
  return `image/${format === 'jpeg' ? 'jpeg' : format}`;
}

async function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('Please choose an image file.', 'error');
    return;
  }

  controller?.abort();
  controller = new AbortController();
  releaseUrls();
  els.result.hidden = true;

  const maxEdge = Number(els.maxEdge.value) || 800;
  const format = els.format.value;
  const maxSizeKB = Number(els.maxSizeKB.value) || undefined;
  const mime = mimeFor(format);
  const started = performance.now();

  try {
    const info = await getImageInfo(file);
    setStatus(`Read ${info.format.toUpperCase()} ${info.width}x${info.height} (orientation ${info.orientation})...`);

    const raw = await worker.decode(file, { signal: controller.signal });
    const ops = [
      { op: 'orient', orientation: info.orientation },
      { op: 'resize', width: maxEdge, height: maxEdge, fit: 'inside', kernel: 'lanczos3' },
    ];
    if (els.sharpen.checked) ops.push({ op: 'sharpen', amount: 0.5, radius: 1 });
    const resized = await worker.process(
      raw,
      ops,
      {
        signal: controller.signal,
        onProgress: ({ phase, ratio }) => {
          if (ratio !== undefined) setStatus(`${phase} ${Math.round(ratio * 100)}%...`);
        },
      },
    );

    let blob;
    if (maxSizeKB && mime !== 'image/png') {
      blob = await compressImage(file, {
        maxSizeKB,
        maxWidthOrHeight: maxEdge,
        worker,
        format,
        signal: controller.signal,
      });
    } else {
      blob = await worker.encode(resized, { type: mime, quality: 0.85 }, { signal: controller.signal });
    }

    if (els.strip.checked) blob = await stripMetadata(blob);

    setStatus('Building srcset variants and placeholder...');
    const variants = await generateSrcSet(file, {
      widths: [320, 640, 1280],
      format,
      worker,
      signal: controller.signal,
    });
    const placeholder = await generatePlaceholder(file, { worker, signal: controller.signal });

    const outInfo = await getImageInfo(blob);
    const elapsed = Math.round(performance.now() - started);
    const ratio = ((1 - blob.size / file.size) * 100).toFixed(1);

    els.original.src = trackUrl(URL.createObjectURL(file));
    els.processed.src = trackUrl(URL.createObjectURL(blob));
    els.originalMeta.textContent = `${info.displayWidth}x${info.displayHeight} · ${formatBytes(file.size)}`;
    els.processedMeta.textContent = `${outInfo.width}x${outInfo.height} · ${formatBytes(blob.size)}`;
    els.placeholder.src = placeholder.dataURL;
    els.placeholder.style.aspectRatio = `${placeholder.width} / ${placeholder.height}`;
    els.placeholderMeta.textContent = `${placeholder.hash.length} bytes`;
    els.variants.replaceChildren(
      ...variants.map((variant) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = trackUrl(URL.createObjectURL(variant.blob));
        link.target = '_blank';
        link.textContent = variant.descriptor;
        item.append(link, ` ${variant.width}x${variant.height} · ${formatBytes(variant.blob.size)}`);
        return item;
      }),
    );
    els.download.href = els.processed.src;
    els.download.download = `processed.${format}`;
    els.result.hidden = false;

    setStatus(
      `Done in ${elapsed} ms (worker: ${worker.mode}) — ${format.toUpperCase()} at ${formatBytes(blob.size)}, ` +
        `${ratio}% smaller than the original.`,
      'done',
    );
  } catch (error) {
    if (error?.code === 'ABORTED') {
      setStatus('Cancelled (a new file was chosen).');
      return;
    }
    console.error(error);
    setStatus(`${error?.code ?? 'ERROR'}: ${error?.message ?? error}`, 'error');
  }
}

els.dropzone.addEventListener('click', () => els.file.click());
els.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') els.file.click();
});
els.file.addEventListener('change', () => handleFile(els.file.files?.[0]));

for (const type of ['dragenter', 'dragover']) {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove('dragging');
  });
}
els.dropzone.addEventListener('drop', (event) => handleFile(event.dataTransfer?.files?.[0]));

window.addEventListener('beforeunload', () => {
  controller?.abort();
  worker.dispose();
  releaseUrls();
});

Promise.all([canEncode('webp'), canEncode('avif'), canEncode('jpeg')]).then(([webp, avif, jpeg]) => {
  if (!jpeg) {
    setStatus('This browser cannot encode images; the demo needs canvas support.', 'error');
    return;
  }
  const formats = [jpeg && 'JPEG', webp && 'WebP', avif && 'AVIF'].filter(Boolean).join(', ');
  setStatus(`Ready — encoders available: ${formats}. Drop an image to start.`);
});
