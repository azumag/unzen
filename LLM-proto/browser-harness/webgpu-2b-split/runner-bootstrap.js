import { validateBrowserKvGeometry } from './runtime-validation.js';

const params = new URLSearchParams(location.search);
const kvHeads = Number(params.get('kvHeads') ?? 8);
const headSize = Number(params.get('headSize') ?? 64);

validateBrowserKvGeometry({ kvHeads, headSize });

await new Promise((resolve, reject) => {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.min.js';
  script.onload = resolve;
  script.onerror = () => reject(new Error('failed to load ONNX Runtime WebGPU runtime'));
  document.head.append(script);
});

await import('./runner-v3.js');
