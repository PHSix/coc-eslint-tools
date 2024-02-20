import { WorkspaceFolder, window } from 'coc.nvim';

export async function pickFolder(folders: ReadonlyArray<WorkspaceFolder>, placeHolder: string): Promise<WorkspaceFolder | undefined> {
	if (folders.length === 1) {
		return Promise.resolve(folders[0]);
	}

	const selected = await window.showQuickpick(
		folders.map<string>((folder) => { return folder.name; }),
		placeHolder
	);
	if (selected === -1) {
		return undefined;
	}
	return folders[selected];
}

