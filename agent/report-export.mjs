import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sha256 } from './documents.mjs';

const SELF = fileURLToPath(import.meta.url);

export async function resolveExportRuntime(env = process.env) {
  const dependencies = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies');
  const nodeModules = path.resolve(env.RUNTIME_NODE_MODULES || path.join(dependencies, 'node', 'node_modules'));
  const node = path.resolve(env.RUNTIME_NODE || path.join(dependencies, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'));
  const python = path.resolve(env.RUNTIME_PYTHON || path.join(dependencies, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python'));
  let skill = env.PRESENTATIONS_SKILL_DIR;
  if (!skill) {
    const base = path.join(os.homedir(), '.codex', 'plugins', 'cache', 'openai-primary-runtime', 'presentations');
    const versions = await readdir(base).catch(() => []);
    skill = versions.sort().reverse().map(version => path.join(base, version, 'skills', 'presentations'))[0];
  }
  if (!skill) throw new Error('PPTX export requires the bundled presentation runtime and PRESENTATIONS_SKILL_DIR.');
  skill = path.resolve(skill);
  for (const filename of [node, python, path.join(nodeModules, '@oai', 'artifact-tool', 'dist', 'artifact_tool.mjs'), path.join(skill, 'container_tools', 'artifact_tool_utils.mjs')]) {
    try { await access(filename); } catch { throw new Error('PPTX export runtime is unavailable. Configure RUNTIME_NODE_MODULES, RUNTIME_NODE, RUNTIME_PYTHON, and PRESENTATIONS_SKILL_DIR.'); }
  }
  return { nodeModules, node, python, skill, font: env.PRESENTATION_FONT || 'Malgun Gothic' };
}

function markdown(report, source) {
  const clean = value => String(value).replaceAll('\0', '');
  const lines = [`# ${clean(report.title)}`, '', clean(report.summary), ''];
  for (const section of report.sections) {
    lines.push(`## ${clean(section.heading)}`, '', clean(section.text), '', '원문 근거:', '');
    for (const evidence of section.evidence) lines.push(...clean(evidence).split('\n').map(line => `> ${line}`), '');
  }
  lines.push('## 확인 범위', '', ...report.limitations.map(value => `- ${clean(value)}`), '',
    '- 이 문서는 지정한 원문을 바탕으로 AI가 작성하고 검토했습니다. 외부 자료를 통한 사실 확인을 수행하지 않았습니다.',
    '- 원문에서 추출한 앞부분 최대 12,000자를 사용했습니다. 원문 파일은 보존했습니다.', '',
    `원문: ${clean(source.filename)}`, '', `원문 SHA-256: ${source.sha256}`, '');
  return lines.join('\n');
}

function textBox(slide, text, position, { font, size = 30, bold = false, color = '#17263C' }) {
  const shape = slide.shapes.add({ geometry: 'textbox', position, fill: 'none', line: { fill: 'none', width: 0 } });
  shape.text = text;
  shape.text.style = { typeface: font, fontSize: size, bold, color, autoFit: 'none', wrap: 'square', insets: 0 };
  return shape;
}

/** Worker implementation uses native editable text and records private render/validation evidence. */
async function buildArtifacts({ report, source, outputDir, slideCount, deadlineAt, runtime, requestHash }) {
  const workspaceDir = path.resolve(outputDir);
  const build = path.join(workspaceDir, '.build');
  const final = path.join(workspaceDir, 'files');
  const previews = path.join(build, 'slides');
  await mkdir(previews, { recursive: true, mode: 0o700 });
  await mkdir(final, { recursive: true, mode: 0o700 });
  const require = createRequire(path.join(runtime.nodeModules, '__presentation__.cjs'));
  const { markdownToHwpx, parse } = await import('kordoc');
  const { Presentation, PresentationFile } = await import(pathToFileURL(require.resolve('@oai/artifact-tool')).href);
  const { finalizePresentation } = await import(pathToFileURL(path.join(runtime.skill, 'container_tools', 'artifact_tool_utils.mjs')).href);
  let available;
  try {
    available = require('@napi-rs/canvas').GlobalFonts.families.map(entry => entry.family);
  } catch {
    try { available = require('skia-canvas').FontLibrary.families; } catch { available = []; }
  }
  if (!available.some(name => name.toLowerCase() === runtime.font.toLowerCase())) throw new Error('The configured presentation font is not installed.');
  const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  for (const [index, content] of report.slides.entries()) {
    const slide = presentation.slides.add();
    slide.background.fill = index === 0 ? '#17263C' : '#FAFAF7';
    const cover = index === 0;
    textBox(slide, content.title, { left: 76, top: cover ? 150 : 65, width: 1128, height: cover ? 170 : 112 },
      { font: runtime.font, size: cover ? 58 : 44, bold: true, color: cover ? '#FFFFFF' : '#17263C' });
    const body = content.body.join('\n\n');
    textBox(slide, body, { left: 80, top: cover ? 350 : 220, width: 1120, height: cover ? 240 : 380 },
      { font: runtime.font, size: 30, color: cover ? '#DCE8F2' : '#33465A' });
    slide.speakerNotes.text = `원문: ${source.filename}\nSHA-256: ${source.sha256}\n근거:\n${content.evidence.join('\n\n')}\n\n${report.limitations.join('\n')}\n지정한 원문 기반의 AI 초안이며 외부 사실 확인은 수행하지 않았습니다.`;
    const png = await presentation.export({ slide, format: 'png', scale: 1 });
    await writeFile(path.join(previews, `slide-${String(index + 1).padStart(2, '0')}.png`), new Uint8Array(await png.arrayBuffer()));
  }
  const candidatePath = path.join(build, 'candidate.pptx');
  await (await PresentationFile.exportPptx(presentation)).save(candidatePath);
  const finalPath = path.join(final, '발표자료.pptx');
  await finalizePresentation({
    workspaceDir, candidatePath, finalPath, pythonExecutable: runtime.python,
    integrityValidatorPath: path.join(runtime.skill, 'container_tools', 'inspect_presentation_package_integrity.py'),
    layoutValidatorPath: path.join(runtime.skill, 'container_tools', 'inspect_presentation_layout_geometry.py'),
    explicitTotalSlideCount: slideCount,
    requiredNativeTableOwnerSlides: [], requiredNativeChartOwnerSlides: [],
    layoutArgs: ['--expected-slide-size-emu', '12192000,6858000', '--validate-heading-fit'],
    fontPolicy: { basis: 'design', families: [runtime.font] },
    verifyArtifactToolImport: true,
    receiptPath: path.join(build, 'presentation.validation.json'),
  });
  const reportMarkdown = markdown(report, source);
  await writeFile(path.join(final, '보고서.md'), reportMarkdown, { mode: 0o600 });
  const hwpxBytes = Buffer.from(await markdownToHwpx(reportMarkdown, { gongmun: { preset: '보고서' } }));
  await writeFile(path.join(final, '보고서.hwpx'), hwpxBytes, { mode: 0o600 });
  const roundTrip = await parse(hwpxBytes);
  if (!roundTrip.success || !roundTrip.markdown.includes(report.title) || !roundTrip.markdown.includes(source.filename)) {
    throw new Error('The HWPX report did not pass its round-trip content check.');
  }
  const deckPdfPath = path.join(final, '발표자료.pdf');
  const reportPdfPath = path.join(final, '보고서.pdf');
  const pdfReceiptPath = path.join(build, 'pdf.validation.json');
  const pdfRequestPath = path.join(build, 'pdf-render-request.json');
  await writeFile(pdfRequestPath, JSON.stringify({
    report, source, reportPdf: reportPdfPath, presentationPdf: deckPdfPath,
    slidePreviewDirectory: previews,
    slideCount, validationReceipt: pdfReceiptPath,
  }), { mode: 0o600 });
  const pdfTimeoutMs = Date.parse(deadlineAt) - Date.now();
  if (!Number.isFinite(pdfTimeoutMs) || pdfTimeoutMs <= 0) throw new Error('Artifact export deadline exceeded.');
  const pdfSignal = AbortSignal.timeout(Math.min(pdfTimeoutMs, 2_147_483_647));
  await new Promise((resolve, reject) => {
    let errors = '';
    const child = spawn(runtime.python, [path.join(path.dirname(SELF), 'render_report_pdf.py'), pdfRequestPath], {
      cwd: workspaceDir, windowsHide: true, signal: pdfSignal, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', value => { if (errors.length < 1200) errors += value.toString(); });
    child.once('error', () => reject(new Error(pdfSignal.aborted ? 'Artifact export deadline exceeded.' : 'The PDF renderer could not start.')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`PDF conversion or validation failed. ${errors.slice(0, 300)}`)));
  });
  const pdfReceipt = JSON.parse(await readFile(pdfReceiptPath, 'utf8'));
  if (pdfReceipt.reportPages < 1 || pdfReceipt.presentationPages !== slideCount ||
      pdfReceipt.reportTitleVerified !== true || pdfReceipt.sourceFilenameVerified !== true || pdfReceipt.slideRasterPagesVerified !== true) {
    throw new Error('PDF conversion did not pass its page and content checks.');
  }
  const artifacts = [];
  for (const [filename, mime] of [
    ['보고서.md', 'text/markdown'],
    ['보고서.hwpx', 'application/vnd.hancom.hwpx'],
    ['보고서.pdf', 'application/pdf'],
    ['발표자료.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['발표자료.pdf', 'application/pdf'],
  ]) {
    const absolutePath = path.join(final, filename);
    const buffer = await readFile(absolutePath);
    if (buffer.length > 10 * 1024 * 1024) throw new Error('An exported artifact exceeds 10 MB.');
    const hash = sha256(buffer);
    artifacts.push({ id: hash, filename, sha256: hash, bytes: buffer.length, mime, absolutePath });
  }
  const result = {
    requestHash, artifacts, previewDirectory: previews,
    validationReceipt: path.join(build, 'presentation.validation.json'), pdfValidationReceipt: pdfReceiptPath,
  };
  await writeFile(path.join(workspaceDir, 'export-result.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  return result;
}

async function readValidatedExport(outputRoot, requestHash, slideCount) {
  const manifestPath=path.join(outputRoot,'export-result.json');
  const cached=JSON.parse(await readFile(manifestPath,'utf8'));
  if(cached.requestHash!==requestHash||!Array.isArray(cached.artifacts)||cached.artifacts.length!==5||!cached.validationReceipt||!cached.pdfValidationReceipt)throw new Error('A prior document export does not match this request.');
  const actualRoot=await realpath(outputRoot);
  const receiptPath=path.resolve(cached.validationReceipt);
  const expectedReceipt=path.join(outputRoot,'.build','presentation.validation.json');
  if(receiptPath!==expectedReceipt)throw new Error('A prior presentation export has an invalid validation receipt path.');
  const actualReceipt=await realpath(receiptPath);
  const receiptRelative=path.relative(actualRoot,actualReceipt);
  if(receiptRelative.startsWith('..'+path.sep)||receiptRelative==='..'||path.isAbsolute(receiptRelative))throw new Error('A prior presentation validation receipt points outside its result folder.');
  await access(actualReceipt);
  const pdfReceiptPath=path.resolve(cached.pdfValidationReceipt);
  const expectedPdfReceipt=path.join(outputRoot,'.build','pdf.validation.json');
  if(pdfReceiptPath!==expectedPdfReceipt)throw new Error('A prior PDF validation receipt has an invalid path.');
  const actualPdfReceipt=await realpath(pdfReceiptPath);
  const pdfReceiptRelative=path.relative(actualRoot,actualPdfReceipt);
  if(pdfReceiptRelative.startsWith('..'+path.sep)||pdfReceiptRelative==='..'||path.isAbsolute(pdfReceiptRelative))throw new Error('A prior PDF validation receipt points outside its result folder.');
  const pdfReceipt=JSON.parse(await readFile(actualPdfReceipt,'utf8'));
  if(!Number.isSafeInteger(pdfReceipt.reportPages)||pdfReceipt.reportPages<1||pdfReceipt.presentationPages!==slideCount||pdfReceipt.reportTitleVerified!==true||pdfReceipt.sourceFilenameVerified!==true||pdfReceipt.slideRasterPagesVerified!==true)throw new Error('A prior PDF validation receipt is invalid.');
  const expected=new Set(['보고서.md','보고서.hwpx','보고서.pdf','발표자료.pptx','발표자료.pdf']);
  for(const artifact of cached.artifacts){
    if(!expected.delete(artifact.filename)||artifact.id!==artifact.sha256||!/^([a-f0-9]{64})$/.test(artifact.sha256))throw new Error('A prior presentation export has an invalid manifest.');
    const filePath=path.resolve(artifact.absolutePath),actualPath=await realpath(filePath);
    const relative=path.relative(actualRoot,actualPath);
    if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative)||filePath!==path.join(outputRoot,'files',artifact.filename))throw new Error('A prior presentation export points outside its result folder.');
    const bytes=await readFile(actualPath);
    if(bytes.length!==artifact.bytes||sha256(bytes)!==artifact.sha256)throw new Error('A prior presentation export failed its integrity check.');
  }
  if(expected.size)throw new Error('A prior presentation export is missing a required file.');
  return cached;
}

/** Start the bundled authoring runtime in a child so deadlines can stop rendering. */
export async function exportReportArtifacts({ report, source, outputDir, slideCount, deadlineAt }, { env = process.env, signal } = {}) {
  if (!report || !Array.isArray(report.slides) || report.slides.length !== slideCount) throw new Error('The presentation slide count does not match the request.');
  const remaining = Date.parse(deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || signal?.aborted) throw new Error('Artifact export deadline exceeded.');
  const outputRoot=path.resolve(outputDir);
  const requestHash=sha256(JSON.stringify({version:2,report,source,slideCount,font:env.PRESENTATION_FONT||'Malgun Gothic'}));
  try {
    return await readValidatedExport(outputRoot,requestHash,slideCount);
  } catch(error) { if(error.code!=='ENOENT')throw error; }
  const runtime = await resolveExportRuntime(env);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const requestPath = path.join(outputRoot, `.export-request-${randomUUID()}.json`);
  await writeFile(requestPath, JSON.stringify({ report, source, outputDir: outputRoot, slideCount, deadlineAt, runtime, requestHash }), { flag: 'wx', mode: 0o600 });
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.min(remaining, 2_147_483_647))]) : AbortSignal.timeout(Math.min(remaining, 2_147_483_647));
  let workerCode;
  let errors = '';
  await new Promise((resolve, reject) => {
    const child = spawn(runtime.node, [SELF, '--worker', requestPath], {
      cwd: outputRoot, windowsHide: true, signal: combined,
      env: { ...process.env, RUNTIME_NODE_MODULES: runtime.nodeModules }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', value => { if (errors.length < 2000) errors += value.toString(); });
    child.once('error', () => reject(new Error(combined.aborted ? 'Artifact export was interrupted by its deadline.' : 'The presentation export runtime could not start.')));
    child.once('close', code => { workerCode=code; resolve(); });
  });
  if (combined.aborted || Date.now() >= Date.parse(deadlineAt)) throw new Error('Artifact export deadline exceeded.');
  if (workerCode !== 0) {
    // Some Windows child-process exits report failure after the finalizer has atomically
    // published every file. Accept only a complete manifest whose receipt and hashes pass.
    try { return await readValidatedExport(outputRoot,requestHash,slideCount); }
    catch { throw new Error(`Presentation export failed. ${errors.replace(/[A-Za-z]:\\[^\r\n"']+/g, '[local path]').slice(0, 500)}`); }
  }
  return await readValidatedExport(outputRoot,requestHash,slideCount);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF && process.argv[2] === '--worker') {
  buildArtifacts(JSON.parse(await readFile(process.argv[3], 'utf8'))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
