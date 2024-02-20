/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import * as fs from 'fs';
import fsPromises from 'fs/promises';
import {
	workspace as Workspace, window as Window, commands as Commands, Disposable, ExtensionContext, TextDocument, LanguageClient, Uri, Range, CodeActionKind, CancellationTokenSource
} from 'coc.nvim';
import { CodeActionParams, CodeActionRequest, CodeAction } from 'vscode-languageserver-protocol';

import { Validate } from './shared/settings';

import { ESLintClient, Validator } from './client';
import { pickFolder } from './coc-utils';
import {findEslint} from './node-utils';

function createDefaultConfiguration(): void {
	const folders = Workspace.workspaceFolders;
	if (!folders) {
		void Window.showErrorMessage('An ESLint configuration can only be generated if VS Code is opened on a workspace folder.');
		return;
	}
	const noConfigFolders = folders.filter(folder => {
		const configFiles = ['.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc', '.eslintrc.json'];
		for (const configFile of configFiles) {
			if (fs.existsSync(path.join(Uri.parse(folder.uri).fsPath, configFile))) {
				return false;
			}
		}
		return true;
	});
	if (noConfigFolders.length === 0) {
		if (folders.length === 1) {
			void Window.showInformationMessage('The workspace already contains an ESLint configuration file.');
		} else {
			void Window.showInformationMessage('All workspace folders already contain an ESLint configuration file.');
		}
		return;
	}

	void pickFolder(noConfigFolders, 'Select a workspace folder to generate a ESLint configuration for').then(async (folder) => {
		if (!folder) {
			return;
		}
		const folderRootPath = Uri.parse(folder.uri).fsPath;
		const terminal = await Window.createTerminal({
			name: `ESLint init`,
			cwd: folderRootPath
		});
		const eslintCommand = await findEslint(folderRootPath);
		terminal.sendText(`${eslintCommand} --init`);
		await terminal.show();
	}).catch(err => {
		Workspace.nvim.echoError('createConfig failed, checkout reason in :CocCommand eslint.showOutputChannel.');
		client.error('createConfig failed',err);
	});
}

let onActivateCommands: Disposable[] | undefined;
let client: LanguageClient;
const validator: Validator = new Validator();

export function activate(context: ExtensionContext) {

	function didOpenTextDocument(textDocument: TextDocument) {
		if (activated) {
			return;
		}
		if (validator.check(textDocument) !== Validate.off) {
			openListener.dispose();
			configurationListener.dispose();
			activated = true;
			realActivate(context);
		}
	}

	function configurationChanged() {
		if (activated) {
			return;
		}
		for (const textDocument of Workspace.textDocuments) {
			if (validator.check(textDocument) !== Validate.off) {
				openListener.dispose();
				configurationListener.dispose();
				activated = true;
				realActivate(context);
				return;
			}
		}
	}

	let activated: boolean = false;
	const openListener: Disposable = Workspace.onDidOpenTextDocument(didOpenTextDocument);
	const configurationListener: Disposable = Workspace.onDidChangeConfiguration(configurationChanged);

	const notValidating = () => {
		const enabled = Workspace.getConfiguration('eslint', Window.activeTextEditor?.document).get('enable', true);
		if (!enabled) {
			void Window.showInformationMessage(`ESLint is not running because the deprecated setting 'eslint.enable' is set to false. Remove the setting and use the extension disablement feature.`);
		} else {
			void Window.showInformationMessage('ESLint is not running. By default only TypeScript and JavaScript files are validated. If you want to validate other file types please specify them in the \'eslint.probe\' setting.');
		}
	};
	onActivateCommands = [
		Commands.registerCommand('eslint.executeAutofix', notValidating),
		Commands.registerCommand('eslint.showOutputChannel', notValidating),
		Commands.registerCommand('eslint.restart', notValidating)
	];

	context.subscriptions.push(
		Commands.registerCommand('eslint.createConfig', createDefaultConfiguration)
	);

	configurationChanged();
}


function realActivate(context: ExtensionContext): void {

	if (onActivateCommands) {
		onActivateCommands.forEach(command => command.dispose());
		onActivateCommands = undefined;
	}

	let acknowledgePerformanceStatus: () => void;
	[client, acknowledgePerformanceStatus] = ESLintClient.create(context, validator);

	context.subscriptions.push(
		Commands.registerCommand('eslint.showOutputChannel', async () => {
			client.outputChannel.show();
			acknowledgePerformanceStatus();
		}),
		Commands.registerCommand('eslint.restart', () => {
			try {
				client.restart();
			}
			catch(error) { client.error(`Restarting client failed`, error );}
		})
	);

	client.start().catch((error) => {
		client.error(`Starting the server failed.`, error);
		const message = typeof error === 'string' ? error : typeof error.message === 'string' ? error.message : undefined;
		if (message !== undefined && message.indexOf('ENOENT') !== -1) {
			client.info(`PATH environment variable is: ${process.env['PATH']}`);
		}
	});


	const configFiles = ['.eslintrc.js', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc', '.eslintrc.json', 'eslint.config.js'];

	const codeActionOnSave =  Workspace.registerAutocmd({
		request: true,
		event: 'BufWritePre',
		arglist: [`+expand('<abuf>')`],
		callback: async (bufnr: number) => {
			const doc = Workspace.getDocument(bufnr);
			if (!doc || !doc.attached) {
				return;
			}
			const config = Workspace.getConfiguration();
			const eslintConfig = Workspace.getConfiguration('eslint', doc.uri);
			const folder = Workspace.getWorkspaceFolder(Workspace.getDocument(bufnr).uri);
			const onSaveTimeout = eslintConfig.get<number>('fixOnSaveTimeout', 1000);
			if (
				!eslintConfig.get<boolean>('autoFixOnSave', false) || !eslintConfig.get<boolean>('enable', false) || validator.check(doc.textDocument) === Validate.off || folder === undefined || (config.get<boolean>('coc.preferences.formatOnSave', false) && eslintConfig.get<boolean>('format.enable', false))
			) {
				return;
			}

			try {
				await Promise.any(configFiles.map(file => fsPromises.access(path.resolve(Uri.parse(folder.uri).fsPath, file))));
			}catch {
				client.outputChannel.appendLine(`eslint config file not found in buffer: ${bufnr}`);
				return;
			}

			client.outputChannel.appendLine(`Auto fix on save for buffer: ${bufnr}`);
			const params: CodeActionParams = {
				textDocument: {
					uri: doc.uri
				},
				range: Range.create(0, 0, doc.textDocument.lineCount, 0),
				context: {
					only: [`${CodeActionKind.SourceFixAll}.eslint`],
					diagnostics: []
				},
			};
			const source = new CancellationTokenSource();
			let timer: NodeJS.Timeout | undefined  = undefined;
			const tf = new Promise<void>(resolve => {
				timer = setTimeout(() => {
					client.outputChannel.appendLine(`Auto fix timeout for buffer: ${bufnr}`);
					source.cancel();
					resolve();
				}, onSaveTimeout);
			});

			try {

				const res = await Promise.race([tf, client.sendRequest(CodeActionRequest.type.method, params, source.token)]);
				clearTimeout(timer);
				if (source.token.isCancellationRequested) {return;}
				if (res && Array.isArray(res)) {
					if (CodeAction.is(res[0])) {
						client.outputChannel.appendLine(`Apply auto fix for buffer: ${bufnr}`);
						if (res[0].edit) {
							await Workspace.applyEdit(res[0].edit);
						}
					}
				}
			}catch (err) {
				Workspace.nvim.echoError('eslint autoFixOnSave meet some wrong, please checkout reason by :CocCommand eslint.showOutputChannel');
				client.error('eslint autoFixOnSave error:', err);
			}
		}
	});

	context.subscriptions.push(codeActionOnSave);
}

export function deactivate(): Promise<void> {
	if (onActivateCommands !== undefined) {
		onActivateCommands.forEach(command => command.dispose());
	}
	return client !== undefined ? client.stop() : Promise.resolve();
}
