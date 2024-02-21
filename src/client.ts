
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';

import {
	workspace as Workspace, window as Window, Uri, TextDocument, CodeActionContext, Diagnostic,
	Command, CodeAction, MessageItem,  CodeActionKind, WorkspaceConfiguration, commands,
	ExtensionContext, ErrorAction,
	LanguageClient, LanguageClientOptions, TransportKind, ErrorHandler, CloseAction, RevealOutputChannelOn, ServerOptions, DocumentFilter,
	ConfigurationParams,State
} from 'coc.nvim';

import {
	DidCloseTextDocumentNotification, DidOpenTextDocumentNotification,  VersionedTextDocumentIdentifier, ExecuteCommandParams,
	ExecuteCommandRequest,
} from 'vscode-languageserver-protocol';

import { LegacyDirectoryItem, PatternItem, ValidateItem } from './settings';
import { ExitCalled, NoConfigRequest, NoESLintLibraryRequest, OpenESLintDocRequest, ProbeFailedRequest, ShowOutputChannel, Status, StatusNotification, StatusParams } from './shared/customMessages';
import { CodeActionSettings, CodeActionsOnSaveMode, CodeActionsOnSaveRules, ConfigurationSettings, DirectoryItem, ESLintOptions, ESLintSeverity, ModeItem, PackageManagers, RuleCustomization, RunValues, Validate } from './shared/settings';
import { convert2RegExp, Is,  toOSPath, toPosixPath } from './node-utils';

export class Validator {

	private readonly probeFailed: Set<string> = new Set();

	public clear(): void {
		this.probeFailed.clear();
	}

	public add(uri: Uri): void {
		this.probeFailed.add(uri.toString());
	}

	public check(textDocument: TextDocument): Validate {
		const config = Workspace.getConfiguration('eslint', textDocument.uri);

		if (!config.get<boolean>('enable', true)) {
			return Validate.off;
		}

		if (config.get<boolean>('ignoreUntitled', false)) {
			return Validate.off;
		}

		const languageId = textDocument.languageId;
		const validate = config.get<(ValidateItem | string)[]>('validate');
		if (Array.isArray(validate)) {
			for (const item of validate) {
				if (Is.string(item) && item === languageId) {
					return Validate.on;
				} else if (ValidateItem.is(item) && item.language === languageId) {
					return Validate.on;
				}
			}
		}

		if (this.probeFailed.has(textDocument.uri.toString())) {
			return Validate.off;
		}

		const probe: string[] | undefined = config.get<string[]>('probe');
		if (Array.isArray(probe)) {
			for (const item of probe) {
				if (item === languageId) {
					return Validate.probe;
				}
			}
		}

		return Validate.off;
	}
}

type NoESLintState = {
	global?: boolean;
	workspaces?: { [key: string]: boolean };
};

export namespace ESLintClient {

	type PerformanceStatus = {
		firstReport: boolean;
		validationTime: number;
		fixTime: number;
		reported: number;
		acknowledged: boolean;
	};

	namespace PerformanceStatus {
		export const defaultValue: PerformanceStatus = { firstReport: true, validationTime: 0, fixTime: 0, reported: 0, acknowledged: false };
	}

	export function create(context: ExtensionContext, validator: Validator): [LanguageClient, () => void] {

		// Filters for client options
		const packageJsonFilter: DocumentFilter = { scheme: 'file', pattern: '**/package.json' };
		const configFileFilter: DocumentFilter = { scheme: 'file', pattern: '**/{.eslintr{c.js,c.yaml,c.yml,c,c.json},eslint.config.js}' };
		const supportedQuickFixKinds: Set<string> = new Set([CodeActionKind.Source, CodeActionKind.SourceFixAll, `${CodeActionKind.SourceFixAll}.eslint`, CodeActionKind.QuickFix]);

		// A map of documents synced to the server
		const syncedDocuments: Map<string, TextDocument> = new Map();
		// The actual ESLint client
		const client: LanguageClient = new LanguageClient('ESLint', createServerOptions(Uri.parse(context.extensionPath)), createClientOptions());

		// The default error handler.
		const defaultErrorHandler: ErrorHandler = {
			error:() => ErrorAction.Continue,
			closed: ()=> CloseAction.Restart
		};
		// Whether the server call process.exit() which is intercepted and reported to
		// the client
		let serverCalledProcessExit: boolean = false;

		const starting = 'ESLint server is starting.';
		const running = 'ESLint server is running.';
		const stopped = 'ESLint server stopped.';
		type StatusInfo = Omit<Omit<StatusParams, 'uri'>, 'validationTime'> & {
		};
		const documentStatus: Map<string, StatusInfo> = new Map();
		const performanceStatus: Map<string, PerformanceStatus> = new Map();

		// If the workspace configuration changes we need to update the synced documents since the
		// list of probe language type can change.
		context.subscriptions.push(Workspace.onDidChangeConfiguration(() => {
			validator.clear();
			for (const textDocument of syncedDocuments.values()) {
				if (validator.check(textDocument) === Validate.off) {
					const provider = (client as any).getFeature(DidCloseTextDocumentNotification.method).getProvider(textDocument);
					provider?.send(textDocument).catch((error: unknown) => client.error(`Sending close notification failed.`, error));
				}
			}
			for (const textDocument of Workspace.textDocuments) {
				if (!syncedDocuments.has(textDocument.uri.toString()) && validator.check(textDocument) !== Validate.off) {
					const provider = (client as any).getFeature(DidOpenTextDocumentNotification.method).getProvider(textDocument);
					provider?.send(textDocument).catch((error: unknown) => client.error(`Sending open notification failed.`, error));
				}
			}
		}));

		client.onNotification(ShowOutputChannel.type.method, () => {
			client.outputChannel.show();
		});

		client.onNotification(StatusNotification.type.method, (params) => {
			updateDocumentStatus(params);
		});

		client.onNotification(ExitCalled.type.method, (params) => {
			serverCalledProcessExit = true;
			client.error(`Server process exited with code ${params[0]}. This usually indicates a misconfigured ESLint setup.`, params[1]);
			void Window.showErrorMessage(`ESLint server shut down itself. See 'ESLint' output channel for details.`, { title: 'Open Output', id: 1 }).then((value) => {
				if (value !== undefined && value.id === 1) {
					client.outputChannel.show();
				}
			});
		});

		client.onRequest(NoConfigRequest.type.method, (params) => {
			const document = Uri.parse(params.document.uri);
			const workspaceFolder = Workspace.getWorkspaceFolder(document.fsPath);
			const fileLocation = document.fsPath;
			if (workspaceFolder) {
				client.warn([
					'',
					`No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
					`File will not be validated. Consider running 'eslint --init' in the workspace folder ${workspaceFolder.name}`,
					`Alternatively you can disable ESLint by executing the 'Disable ESLint' command.`
				].join('\n'));
			} else {
				client.warn([
					'',
					`No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
					`File will not be validated. Alternatively you can disable ESLint by executing the 'Disable ESLint' command.`
				].join('\n'));
			}

			updateDocumentStatus({ uri: params.document.uri, state: Status.error });
			return {};
		});

		client.onRequest(NoESLintLibraryRequest.type.method, async (params) => {
			const key = 'noESLintMessageShown';
			const state = context.globalState.get<NoESLintState>(key, {});

			const uri: Uri = Uri.parse(params.source.uri);
			const workspaceFolder = Workspace.getWorkspaceFolder(uri.fsPath);
			const packageManager = await getPackageManager(uri);
			const localInstall = {
				npm: 'npm install eslint',
				pnpm: 'pnpm install eslint',
				yarn: 'yarn add eslint',
			};
			const globalInstall = {
				npm: 'npm install -g eslint',
				pnpm: 'pnpm install -g eslint',
				yarn: 'yarn global add eslint'
			};
			const isPackageManagerNpm = packageManager === 'npm';
			interface ButtonItem extends MessageItem {
				id: number;
			}
			const outputItem: ButtonItem = {
				title: 'Go to output',
				id: 1
			};
			if (workspaceFolder) {
				client.info([
					'',
					`Failed to load the ESLint library for the document ${uri.fsPath}`,
					'',
					`To use ESLint please install eslint by running ${localInstall[packageManager]} in the workspace folder ${workspaceFolder.name}`,
					`or globally using '${globalInstall[packageManager]}'. You need to reopen the workspace after installing eslint.`,
					'',
					isPackageManagerNpm ? 'If you are using yarn or pnpm instead of npm set the setting `eslint.packageManager` to either `yarn` or `pnpm`' : null,
					`Alternatively you can disable ESLint for the workspace folder ${workspaceFolder.name} by executing the 'Disable ESLint' command.`
				].filter((str => (str !== null))).join('\n'));

				if (state.workspaces === undefined) {
					state.workspaces = {};
				}
				if (!state.workspaces[workspaceFolder.uri.toString()]) {
					state.workspaces[workspaceFolder.uri.toString()] = true;
					void context.globalState.update(key, state);
					void Window.showInformationMessage(`Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`, outputItem).then((item) => {
						if (item && item.id === 1) {
							client.outputChannel.show(true);
						}
					});
				}
			} else {
				client.info([
					`Failed to load the ESLint library for the document ${uri.fsPath}`,
					`To use ESLint for single JavaScript file install eslint globally using '${globalInstall[packageManager]}'.`,
					isPackageManagerNpm ? 'If you are using yarn or pnpm instead of npm set the setting `eslint.packageManager` to either `yarn` or `pnpm`' : null,
					'You need to reopen VS Code after installing eslint.',
				].filter((str => (str !== null))).join('\n'));

				if (!state.global) {
					state.global = true;
					void context.globalState.update(key, state);
					void Window.showInformationMessage(`Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`, outputItem).then((item) => {
						if (item && item.id === 1) {
							client.outputChannel.show(true);
						}
					});
				}
			}
			return {};
		});

		client.onRequest(OpenESLintDocRequest.method, async (params) => {
			await commands.executeCommand('vscode.open', Uri.parse(params.url));
			return {};
		});

		client.onRequest(ProbeFailedRequest.method, (params) => {
			validator.add(Uri.parse(params.textDocument.uri));
			const closeFeature = (client as any).getFeature(DidCloseTextDocumentNotification.method);
			for (const document of Workspace.textDocuments) {
				if (document.uri.toString() === params.textDocument.uri) {
					closeFeature.getProvider(document)?.send(document).catch((error: unknown) => client.error(`Sending close notification failed`, error));
				}
			}
		});

		client.onDidChangeState((event) => {
			if (event.newState === State.Starting) {
				client.info(starting);
			} else if (event.newState === State.Running) {
				client.info(running);
			} else {
				client.info(stopped);
			}
		});

		context.subscriptions.push(
			Workspace.onDidCloseTextDocument((document) => {
				const uri = document.uri.toString();
				documentStatus.delete(uri);
			}),
			commands.registerCommand('eslint.executeAutofix', async () => {
				const textEditor = Window.activeTextEditor;
				if (!textEditor) {
					return;
				}
				const textDocument: VersionedTextDocumentIdentifier = {
					uri: textEditor.document.uri.toString(),
					version: textEditor.document.version
				};
				const params: ExecuteCommandParams = {
					command: 'eslint.applyAllFixes',
					arguments: [textDocument]
				};
				await client.start();
				client.sendRequest(ExecuteCommandRequest.method, params).then(undefined, () => {
					void Window.showErrorMessage('Failed to apply ESLint fixes to the document. Please consider opening an issue with steps to reproduce.');
				});
			})
		);

		return [client, acknowledgePerformanceStatus];

		function createServerOptions(extensionUri: Uri): ServerOptions {
			// const serverModule = Uri.joinPath(extensionUri, 'server', 'out', 'eslintServer.js').fsPath;
			const serverModule = path.resolve(extensionUri.fsPath, 'eslintServer.js');
			const eslintConfig = Workspace.getConfiguration('eslint');
			const debug = sanitize(eslintConfig.get<boolean>('debug', false) ?? false, 'boolean', false);
			const runtime = sanitize(eslintConfig.get<string | null>('runtime', null) ?? undefined, 'string', undefined);
			const execArgv = sanitize(eslintConfig.get<string[] | null>('execArgv', null) ?? undefined, 'string', undefined);
			const nodeEnv = sanitize(eslintConfig.get<string | null>('nodeEnv', null) ?? undefined, 'string', undefined);

			let env: { [key: string]: string | number | boolean } | undefined;
			if (debug) {
				env = env || {};
				env.DEBUG = 'eslint:*,-eslint:code-path,eslintrc:*';
			}
			if (nodeEnv !== undefined) {
				env = env || {};
				env.NODE_ENV = nodeEnv;
			}
			const debugArgv = ['--nolazy', '--inspect=6011'];
			const result: ServerOptions = {
				run: { module: serverModule, transport: TransportKind.ipc, runtime, options: { execArgv, cwd: process.cwd(), env } },
				debug: { module: serverModule, transport: TransportKind.ipc, runtime, options: { execArgv: execArgv !== undefined ? execArgv.concat(debugArgv) : debugArgv, cwd: process.cwd(), env } }
			};
			return result;
		}

		function sanitize<T, D>(value: T, type: 'bigint' | 'boolean' | 'function' | 'number' | 'object' | 'string' | 'symbol' | 'undefined', def: D): T | D {
			if (Array.isArray(value)) {
				return value.filter(item => typeof item === type) as unknown as T;
			} else if (typeof value !== type) {
				return def;
			}
			return value;
		}

		function createClientOptions(): LanguageClientOptions {
			const clientOptions: LanguageClientOptions = {
				documentSelector: [{ scheme: 'file' }],
				diagnosticCollectionName: 'eslint',
				revealOutputChannelOn: RevealOutputChannelOn.Never,
				initializationOptions: {
				},
				progressOnInitialization: true,
				synchronize: {
					fileEvents: [
						Workspace.createFileSystemWatcher('**/.eslintr{c.js,c.cjs,c.yaml,c.yml,c,c.json}'),
						Workspace.createFileSystemWatcher('**/eslint.config.js'),
						Workspace.createFileSystemWatcher('**/.eslintignore'),
						Workspace.createFileSystemWatcher('**/package.json')
					]
				},
				initializationFailedHandler: (error) => {
					client.error('Server initialization failed.', error);
					client.outputChannel.show(true);
					return false;
				},
				errorHandler: {
					error: (error, message, count) => {
						return defaultErrorHandler.error(error, message, count);
					},
					closed: () => {
						if (serverCalledProcessExit) {
							return CloseAction.DoNotRestart;
						}
						return defaultErrorHandler.closed();
					}
				},
				middleware: {
					didOpen: async (document, next) => {
						if (Workspace.match([packageJsonFilter], document) || Workspace.match([configFileFilter], document) || validator.check(document) !== Validate.off) {
							const result = next(document);
							syncedDocuments.set(document.uri.toString(), document);

							return result;
						}
					},
					didChange: async (event, next) => {
						if (syncedDocuments.has(event.textDocument.uri.toString())) {
							return next(event);
						}
					},
					willSave: async (event, next) => {
						if (syncedDocuments.has(event.document.uri.toString())) {
							return next(event);
						}
					},
					willSaveWaitUntil: (event, next) => {
						if (syncedDocuments.has(event.document.uri.toString())) {
							return next(event);
						} else {
							return Promise.resolve([]);
						}
					},
					didSave: async (document, next) => {
						if (syncedDocuments.has(document.uri.toString())) {
							return next(document);
						}
					},
					didClose: async (document, next) => {
						const uri = document.uri.toString();
						if (syncedDocuments.has(uri)) {
							syncedDocuments.delete(uri);
							return next(document);
						}
					},
					provideCodeActions: async (document, range, context, token, next): Promise<(Command | CodeAction)[] | null | undefined> => {
						if (!syncedDocuments.has(document.uri.toString())) {
							return [];
						}
						if (context.only !== undefined && !context.only.some(value => supportedQuickFixKinds.has(value)) ) {
							return [];
						}
						if (context.only === undefined && (!context.diagnostics || context.diagnostics.length === 0)) {
							return [];
						}
						const eslintDiagnostics: Diagnostic[] = [];
						for (const diagnostic of context.diagnostics) {
							if (diagnostic.source === 'eslint') {
								eslintDiagnostics.push(diagnostic);
							}
						}
						if (context.only === undefined && eslintDiagnostics.length === 0) {
							return [];
						}
						const newContext: CodeActionContext = Object.assign({}, context, { diagnostics: eslintDiagnostics });
						const start = Date.now();
						const result = await next(document, range, newContext, token);
						if (context.only?.some(value => value.startsWith('source.fixAll'))) {
							let performanceInfo = performanceStatus.get(document.languageId);
							if (performanceInfo === undefined) {
								performanceInfo = PerformanceStatus.defaultValue;
								performanceStatus.set(document.languageId, performanceInfo);
							} else {
								performanceInfo.firstReport = false;
							}
							performanceInfo.fixTime = Date.now() - start;
						}
						return result;
					},
					workspace: {
						didChangeWatchedFile: (event, next) => {
							validator.clear();
							return next(event);
						},
						didChangeConfiguration: async (sections, next) => {
							return next(sections);
						},
						configuration: (params) => {
							return readConfiguration(params);
						}
					}
				},
			};
			return clientOptions;
		}

		async function getPackageManager(uri: Uri) {
			const userProvidedPackageManager:PackageManagers = Workspace.getConfiguration('eslint', uri).get('packageManager', 'npm');
			const detectedPackageMananger = await commands.executeCommand<PackageManagers>('npm.packageManager');

			if (userProvidedPackageManager === detectedPackageMananger) {
				return detectedPackageMananger;
			}
			client.warn(`Detected package manager(${detectedPackageMananger}) differs from the one in the deprecated packageManager setting(${userProvidedPackageManager}). We will honor this setting until it is removed.`, {});
			return userProvidedPackageManager;
		}

		async function readConfiguration(params: ConfigurationParams): Promise<(ConfigurationSettings | null)[]> {
			if (params.items === undefined) {
				return [];
			}
			const result: (ConfigurationSettings | null)[] = [];
			for (const item of params.items) {
				if (item.section || !item.scopeUri) {
					result.push(null);
					continue;
				}
				const resource = Uri.parse(item.scopeUri);
				const textDocument = getTextDocument(resource);
				const config = Workspace.getConfiguration('eslint', textDocument ?? resource);
				const workspaceFolder =  Workspace.getWorkspaceFolder(item.scopeUri);
				const settings: ConfigurationSettings = {
					validate: Validate.off,
					packageManager: config.get<PackageManagers>('packageManager', 'npm'),
					useESLintClass: config.get<boolean>('useESLintClass', false),
					experimental: {
						useFlatConfig: config.get<boolean>('experimental.useFlatConfig', false)
					},
					codeActionOnSave: {
						mode: CodeActionsOnSaveMode.all
					},
					format: false,
					quiet: config.get<boolean>('quiet', false),
					onIgnoredFiles: ESLintSeverity.from(config.get<string>('onIgnoredFiles', ESLintSeverity.off)),
					options: config.get<ESLintOptions>('options', {}),
					rulesCustomizations: getRuleCustomizations(config),
					run: config.get<RunValues>('run', 'onType'),
					problems: {
						shortenToSingleLine: config.get<boolean>('problems.shortenToSingleLine', false),
					},
					nodePath: config.get<string | undefined>('nodePath', undefined) ?? null,
					workingDirectory: undefined,
					workspaceFolder: undefined,
					codeAction: {
						disableRuleComment: config.get<CodeActionSettings['disableRuleComment']>('codeAction.disableRuleComment', { enable: true, location: 'separateLine' as const, commentStyle: 'line' as const }),
						showDocumentation: config.get<CodeActionSettings['showDocumentation']>('codeAction.showDocumentation', { enable: true })
					}
				};
				const document: TextDocument | undefined = syncedDocuments.get(item.scopeUri);
				if (document === undefined) {
					result.push(settings);
					continue;
				}
				if (config.get<boolean>('enabled', true)) {
					settings.validate = validator.check(document);
				}
				if (settings.validate !== Validate.off) {
					settings.format = !!config.get<boolean>('format.enable', false);
					settings.codeActionOnSave.mode = CodeActionsOnSaveMode.from(config.get<CodeActionsOnSaveMode>('codeActionsOnSave.mode', CodeActionsOnSaveMode.all));
					settings.codeActionOnSave.rules = CodeActionsOnSaveRules.from(config.get<string[] | null>('codeActionsOnSave.rules', null));
				}
				if (workspaceFolder !== undefined) {
					settings.workspaceFolder = {
						name: workspaceFolder.name,
						uri: workspaceFolder.uri
					};
				}
				const workingDirectories = config.get<(string | LegacyDirectoryItem | DirectoryItem | PatternItem | ModeItem)[] | undefined>('workingDirectories', undefined);
				if (Array.isArray(workingDirectories)) {
					let workingDirectory: ModeItem | DirectoryItem | undefined = undefined;
					const workspaceFolderPath = workspaceFolder && Uri.parse(workspaceFolder.uri).scheme === 'file' ? Uri.parse(workspaceFolder.uri).fsPath : undefined;
					for (const entry of workingDirectories) {
						let directory: string | undefined;
						let pattern: string | undefined;
						let noCWD = false;
						if (Is.string(entry)) {
							directory = entry;
						} else if (LegacyDirectoryItem.is(entry)) {
							directory = entry.directory;
							noCWD = !entry.changeProcessCWD;
						} else if (DirectoryItem.is(entry)) {
							directory = entry.directory;
							if (entry['!cwd'] !== undefined) {
								noCWD = entry['!cwd'];
							}
						} else if (PatternItem.is(entry)) {
							pattern = entry.pattern;
							if (entry['!cwd'] !== undefined) {
								noCWD = entry['!cwd'];
							}
						} else if (ModeItem.is(entry)) {
							workingDirectory = entry;
							continue;
						}

						let itemValue: string | undefined;
						if (directory !== undefined || pattern !== undefined) {
							const filePath = Uri.parse(document.uri).scheme === 'file' ? Uri.parse(document.uri).fsPath : undefined;
							if (filePath !== undefined) {
								if (directory !== undefined) {
									directory = toOSPath(directory);
									if (!path.isAbsolute(directory) && workspaceFolderPath !== undefined) {
										directory = path.join(workspaceFolderPath, directory);
									}
									if (directory.charAt(directory.length - 1) !== path.sep) {
										directory = directory + path.sep;
									}
									if (filePath.startsWith(directory)) {
										itemValue = directory;
									}
								} else if (pattern !== undefined && pattern.length > 0) {
									if (!path.posix.isAbsolute(pattern) && workspaceFolderPath !== undefined) {
										pattern = path.posix.join(toPosixPath(workspaceFolderPath), pattern);
									}
									if (pattern.charAt(pattern.length - 1) !== path.posix.sep) {
										pattern = pattern + path.posix.sep;
									}
									const regExp: RegExp | undefined = convert2RegExp(pattern);
									if (regExp !== undefined) {
										const match = regExp.exec(filePath);
										if (match !== null && match.length > 0) {
											itemValue = match[0];
										}
									}
								}
							}
						}
						if (itemValue !== undefined) {
							if (workingDirectory === undefined || ModeItem.is(workingDirectory)) {
								workingDirectory = { directory: itemValue, '!cwd': noCWD };
							} else {
								if (workingDirectory.directory.length < itemValue.length) {
									workingDirectory.directory = itemValue;
									workingDirectory['!cwd'] = noCWD;
								}
							}
						}
					}
					settings.workingDirectory = workingDirectory;
				}
				result.push(settings);
			}
			return result;
		}

		function parseRulesCustomizations(rawConfig: unknown): RuleCustomization[] {
			if (!rawConfig || !Array.isArray(rawConfig)) {
				return [];
			}

			return rawConfig.map(rawValue => {
				if (typeof rawValue.severity === 'string' && typeof rawValue.rule === 'string') {
					return {
						severity: rawValue.severity,
						rule: rawValue.rule,
					};
				}

				return undefined;
			}).filter((value): value is RuleCustomization => !!value);
		}

		function getRuleCustomizations(config: WorkspaceConfiguration): RuleCustomization[] {
			let customizations: RuleCustomization[] | undefined = undefined;
			if (customizations === undefined || customizations === null) {
				customizations = config.get<RuleCustomization[] | undefined>('rules.customizations');
			}
			return parseRulesCustomizations(customizations);
		}

		function getTextDocument(uri: Uri): TextDocument | undefined {
			return syncedDocuments.get(uri.toString());
		}

		function updateDocumentStatus(params: StatusParams): void {
			documentStatus.set(params.uri, { state: params.state });
			const textDocument = syncedDocuments.get(params.uri);
			if (textDocument !== undefined) {
				let performanceInfo = performanceStatus.get(textDocument.languageId);
				if (performanceInfo === undefined) {
					performanceInfo = PerformanceStatus.defaultValue;
					performanceStatus.set(textDocument.languageId, performanceInfo);
				} else {
					performanceInfo.firstReport = false;
				}
				performanceInfo.validationTime = params.validationTime ?? 0;
			}
		}

		function acknowledgePerformanceStatus(): void {
			const activeTextDocument = Window.activeTextEditor?.document;
			if (activeTextDocument === undefined) {
				return;
			}
			const performanceInfo = performanceStatus.get(activeTextDocument.languageId);
			if (performanceInfo === undefined || performanceInfo.reported === 0) {
				return;
			}
			performanceInfo.acknowledged = true;
		}
	}
}
