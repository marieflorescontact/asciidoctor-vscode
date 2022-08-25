import vscode, { CancellationTokenSource, ExtensionContext, Uri, workspace } from 'vscode'
import fs from 'fs'
import yaml from 'js-yaml'
import * as path from 'path'
import AntoraCompletionProvider from './antoraCompletionProvider'
import { disposeAll } from '../../util/dispose'
import * as nls from 'vscode-nls'
import aggregateContent from '@antora/content-aggregator'
import classifyContent from '@antora/content-classifier'
import ContentCatalog from '@antora/content-classifier/lib/content-catalog'

const localize = nls.loadMessageBundle()

export class AntoraSupportManager implements vscode.Disposable {
  private readonly _disposables: vscode.Disposable[] = []

  public constructor (private readonly context: vscode.ExtensionContext) {
    this.context = context
    const workspaceConfiguration = vscode.workspace.getConfiguration('asciidoc', null)
    // look for Antora support setting in workspace state
    const workspaceState: vscode.Memento = this.context.workspaceState
    const isEnableAntoraSupportSettingDefined = workspaceState.get('antoraSupportSetting')
    if (isEnableAntoraSupportSettingDefined === true) {
      const enableAntoraSupport = workspaceConfiguration.get('antora.enableAntoraSupport')
      if (enableAntoraSupport === true) {
        this.activate()
      }
    } else if (isEnableAntoraSupportSettingDefined === undefined) {
      // choice has not been made
      const onDidOpenAsciiDocFileAskAntoraSupport = vscode.workspace.onDidOpenTextDocument(async (textDocument) => {
        if (await antoraConfigExists(textDocument.uri)) {
          const yesAnswer = localize('antora.activateSupport.yes', 'Yes')
          const noAnswer = localize('antora.activateSupport.no', 'No, thanks')
          const answer = await vscode.window.showInformationMessage(
            localize('antora.activateSupport.message', 'We detect that you are working with Antora. Do you want to active Antora support?'),
            yesAnswer,
            noAnswer
          )
          await workspaceState.update('antoraSupportSetting', true)
          const enableAntoraSupport = answer === yesAnswer ? true : (answer === noAnswer ? false : undefined)
          await workspaceConfiguration.update('antora.enableAntoraSupport', enableAntoraSupport)
          if (enableAntoraSupport) {
            this.activate()
          }
          // do not ask again to avoid bothering users
          onDidOpenAsciiDocFileAskAntoraSupport.dispose()
        }
      })
      this._disposables.push(onDidOpenAsciiDocFileAskAntoraSupport)
    }
  }

  private activate (): void {
    const completionProvider = vscode.languages.registerCompletionItemProvider(
      {
        language: 'asciidoc',
        scheme: 'file',
      },
      new AntoraCompletionProvider(),
      '{'
    )
    this._disposables.push(completionProvider)
  }

  public dispose (): void {
    disposeAll(this._disposables)
  }
}

export async function getAntoraConfig (textDocumentUri: Uri): Promise<Uri | undefined> {
  const pathToAsciidocFile = textDocumentUri.fsPath
  const cancellationToken = new CancellationTokenSource()
  cancellationToken.token.onCancellationRequested((e) => {
    console.log('Cancellation requested, cause: ' + e)
  })
  const antoraConfigs = await vscode.workspace.findFiles('**/antora.yml', '/node_modules/', 100, cancellationToken.token)
  // check for Antora configuration
  for (const antoraConfig of antoraConfigs) {
    const modulesPath = path.join(path.dirname(antoraConfig.path), 'modules')
    if (pathToAsciidocFile.startsWith(modulesPath) && pathToAsciidocFile.slice(modulesPath.length).match(/^\/[^/]+\/pages\/.*/)) {
      console.log(`Found an Antora configuration file at ${antoraConfig.fsPath} for the AsciiDoc document ${pathToAsciidocFile}`)
      return antoraConfig
    }
  }
  console.log(`Unable to find an applicable Antora configuration file in [${antoraConfigs.join(', ')}] for the AsciiDoc document ${pathToAsciidocFile}`)
  return undefined
}

export async function antoraConfigExists (textDocumentUri: Uri): Promise<boolean> {
  return await getAntoraConfig(textDocumentUri) !== undefined
}

class AntoraDisabledError extends Error {
}

export async function parseAntoraConfig (textDocumentUri: Uri): Promise<{ [key: string]: any }> {
  const antoraConfigUri = await getAntoraConfig(textDocumentUri)
  if (antoraConfigUri !== undefined) {
    const antoraConfigPath = antoraConfigUri.fsPath
    try {
      return yaml.load(fs.readFileSync(antoraConfigPath, 'utf8'))
    } catch (err) {
      console.log(`Unable to parse ${antoraConfigPath}, cause:` + err.toString())
      return {}
    }
  }
  return {}
}

export async function getAttributes (textDocumentUri: Uri): Promise<{ [key: string]: string }> {
  const doc = await parseAntoraConfig(textDocumentUri)
  if (doc !== {}) {
    return doc.asciidoc.attributes
  } else {
    return {}
  }
}

export async function getContentCatalog (textDocumentUri: Uri, extensionContext: ExtensionContext): Promise<ContentCatalog | undefined> {
  try {
    const playbook = await createPlaybook(textDocumentUri, extensionContext)
    if (playbook !== undefined) {
      const contentAggregate = await aggregateContent(playbook)
      return classifyContent(playbook, contentAggregate)
    }
    return undefined
  } catch (e) {
    if (e instanceof AntoraDisabledError) {
      return undefined
    } else {
      console.log(`Unable to create contentCatalog : ${e}`)
      throw e
    }
  }
}

async function createPlaybook (textDocumentUri: Uri, extensionContext: ExtensionContext): Promise<{
  site: {};
  runtime: {};
  content: {
    sources: {
      startPath: string;
      branches: string;
      url: string
    }[]
  }
} | undefined> {
  const activeAntoraConfig = await getActiveAntoraConfig(textDocumentUri, extensionContext)
  if (activeAntoraConfig === undefined) {
    return undefined
  }
  const contentSourceRootPath = path.dirname(activeAntoraConfig.fsPath)
  const contentSourceRepositoryRootPath = workspace.getWorkspaceFolder(activeAntoraConfig).uri.fsPath
  // https://docs.antora.org/antora/latest/playbook/content-source-start-path/#start-path-key
  const startPath = path.relative(contentSourceRepositoryRootPath, contentSourceRootPath)
  return {
    content: {
      sources: [{
        url: contentSourceRepositoryRootPath,
        branches: 'HEAD',
        startPath,
      }],
    },
    runtime: {},
    site: {},
  }
}

export async function getSrc (textDocumentUri: Uri, contentCatalog: ContentCatalog | undefined):Promise<{ [key: string]: any } | {}> {
  const antoraConfig = await getAntoraConfig(textDocumentUri)
  const doc = await parseAntoraConfig(textDocumentUri)
  if (antoraConfig !== undefined) {
    const contentSourceRootPath = path.dirname(antoraConfig.fsPath)
    if (doc !== {} && contentCatalog !== undefined) {
      try {
        const file = contentCatalog.getByPath({
          component: doc.name,
          version: doc.version,
          path: path.relative(contentSourceRootPath, textDocumentUri.path),
        }
        )
        return {
          component: file.src.component,
          version: file.src.version,
          module: file.src.module,
          family: file.src.family,
          relative: file.src.relative,
        }
      } catch (e) {
        console.log(`Unable to return src : ${e}`)
        return {}
      }
    }
  }

  return {}
}

function getActiveAntoraConfig (textDocumentUri: Uri, extensionContext: ExtensionContext): Promise<Uri | undefined> {
  const workspaceConfiguration = vscode.workspace.getConfiguration('asciidoc', null)
  // look for Antora support setting in workspace state
  const workspaceState: vscode.Memento = extensionContext.workspaceState
  const isEnableAntoraSupportSettingDefined = workspaceState.get('antoraSupportSetting')
  if (isEnableAntoraSupportSettingDefined === true) {
    const enableAntoraSupport = workspaceConfiguration.get('antora.enableAntoraSupport')
    if (enableAntoraSupport === true) {
      return getAntoraConfig(textDocumentUri)
    }
  }
  //throw new AntoraDisabledError('')
  return undefined
}

export function resolveAntoraResourceIds (id: string, contentCatalog: ContentCatalog | undefined, src: { [key: string]: string }, family: string): string | undefined {
  if (contentCatalog === undefined) {
    return undefined
  }
  const resource = contentCatalog.resolveResource(id, {
    component: src.component,
    version: src.version,
    module: src.module,
  }, family, ['attachment', 'example', 'image', 'page', 'partial'])
  if (resource !== undefined) {
    return resource.src.abspath
  }
  return undefined
}
