import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

type WorkerLabel = 'json' | 'css' | 'html' | 'javascript' | 'typescript'

type WorkerMap = Record<WorkerLabel, new () => Worker>

type MonacoGlobal = typeof self & {
  MonacoEnvironment?: {
    getWorker: (workerId: string, label: string) => Worker
  }
}

const workers: WorkerMap = {
  json: JsonWorker,
  css: CssWorker,
  html: HtmlWorker,
  javascript: TsWorker,
  typescript: TsWorker
}

const globalSelf = self as MonacoGlobal

globalSelf.MonacoEnvironment = {
  getWorker(_workerId, label) {
    const WorkerConstructor = workers[label as WorkerLabel] ?? EditorWorker
    return new WorkerConstructor()
  }
}
