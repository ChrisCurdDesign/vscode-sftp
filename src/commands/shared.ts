import * as path from 'path';
import { Uri, window } from 'vscode';
import { FileType } from '../core';
import { getAllFileService } from '../modules/serviceManager';
import { ExplorerItem } from '../modules/remoteExplorer';
import { getActiveTextEditor } from '../host';
import { listFiles, toLocalPath, simplifyPath } from '../helper';

function configIngoreFilterCreator(config) {
  if (!config || !config.ignore) {
    return;
  }

  return file => !config.ignore(file.fsPath);
}

function createFileSelector(filterCreator?) {
  return async (): Promise<Uri | undefined> => {
    const remoteItems = getAllFileService().map((fileService, index) => {
      const config = fileService.getConfig();
      return {
        name: config.name || config.remotePath,
        description: config.host,
        fsPath: config.remotePath,
        type: FileType.Directory,
        filter: filterCreator ? filterCreator(config) : undefined,
        getFs: () => fileService.getRemoteFileSystem(config),
        index,
        remoteBaseDir: config.remotePath,
        baseDir: fileService.baseDir,
      };
    });

    const selected = await listFiles(remoteItems);

    if (!selected) {
      return;
    }

    const rootItem = remoteItems[selected.index];
    const localTarget = toLocalPath(selected.fsPath, rootItem.remoteBaseDir, rootItem.baseDir);

    return Uri.file(localTarget);
  };
}

export function selectContext(): Promise<Uri | undefined> {
  return new Promise((resolve, reject) => {
    const sercives = getAllFileService();
    const projectsList = sercives
      .map(service => ({
        value: service.baseDir,
        label: service.name || simplifyPath(service.baseDir),
        description: '',
        detail: service.baseDir,
      }))
      .sort((l, r) => l.label.localeCompare(r.label));

    // if (projectsList.length === 1) {
    // return resolve(projectsList[0].value);
    // }

    window
      .showQuickPick(projectsList, {
        placeHolder: 'Select a folder...',
      })
      .then(selection => {
        if (selection) {
          return resolve(Uri.file(selection.value));
        }

        // cancel selection
        resolve(undefined);
      }, reject);
  });
}

export function applySelector<T>(...selectors: ((...args: any[]) => T | Promise<T>)[]) {
  return function combinedSelector(...args: any[]): T | Promise<T> {
    let result;
    for (const selector of selectors) {
      result = selector.apply(this, args);
      if (result) {
        break;
      }
    }

    return result;
  };
}

export function uriFromfspath(fileList: string[]): Uri[] | undefined {
  if (!Array.isArray(fileList) || typeof fileList[0] !== 'string') {
    return;
  }

  return fileList.map(file => Uri.file(file));
}

export function getActiveDocumentUri() {
  const active = getActiveTextEditor();
  if (!active || !active.document) {
    return;
  }

  return active.document.uri;
}

export function getActiveFolder() {
  const uri = getActiveDocumentUri();
  if (!uri) {
    return;
  }

  return Uri.file(path.dirname(uri.fsPath));
}

// selected file or activeTarget or configContext
export function uriFromExplorerContextOrEditorContext(...args): undefined | Uri | Uri[] {
  const [item, items] = args;

  const getScmResourceUriValue = (value): unknown => {
    if (!value) {
      return;
    }

    if ((value as any).resourceUri) {
      return (value as any).resourceUri;
    }

    if ((value as any)._resourceUri) {
      return (value as any)._resourceUri;
    }

    return;
  };

  const isScmResourceState = (value): boolean => {
    return !!getScmResourceUriValue(value);
  };

  const scmResourceUri = (value): Uri | undefined => {
    if (!isScmResourceState(value)) {
      return;
    }

    const rawUri: any = getScmResourceUriValue(value);

    if (rawUri instanceof Uri) {
      return rawUri;
    }

    const resourceUri: any = rawUri;

    if (resourceUri && typeof resourceUri.fsPath === 'string') {
      return Uri.file(resourceUri.fsPath);
    }

    if (resourceUri && typeof resourceUri.scheme === 'string' && typeof resourceUri.path === 'string') {
      try {
        const authority = resourceUri.authority ? `//${resourceUri.authority}` : '';
        const query = resourceUri.query ? `?${resourceUri.query}` : '';
        const fragment = resourceUri.fragment ? `#${resourceUri.fragment}` : '';
        return Uri.parse(`${resourceUri.scheme}:${authority}${resourceUri.path}${query}${fragment}`);
      } catch (_error) {
        // continue to next strategy
      }
    }

    if (resourceUri && typeof resourceUri.toString === 'function') {
      try {
        return Uri.parse(resourceUri.toString());
      } catch (_error) {
        return;
      }
    }

    return;
  };

  const asUri = (value): Uri | undefined => {
    if (value instanceof Uri) {
      return value;
    }

    return scmResourceUri(value);
  };

  const asUriList = (value): Uri[] => {
    if (!value) {
      return [];
    }

    if (Array.isArray(value)) {
      return value
        .map(asUri)
        .filter((uri): uri is Uri => !!uri);
    }

    if (Array.isArray((value as any).resourceStates)) {
      return (value as any).resourceStates
        .map(asUri)
        .filter((uri): uri is Uri => !!uri);
    }

    if (Array.isArray((value as any)._resourceStates)) {
      return (value as any)._resourceStates
        .map(asUri)
        .filter((uri): uri is Uri => !!uri);
    }

    const singleUri = asUri(value);
    if (singleUri) {
      return [singleUri];
    }

    return [];
  };

  const uniqUris = (uris: Uri[]): Uri[] => {
    const set = new Set<string>();
    return uris.filter(uri => {
      const key = uri.toString(true);
      if (set.has(key)) {
        return false;
      }

      set.add(key);
      return true;
    });
  };

  // from explorer or editor context
  if (item instanceof Uri) {
    if (Array.isArray(items) && items[0] instanceof Uri) {
      // multi-select in explorer
      return items;
    } else {
      return item;
    }
  } else if ((item as ExplorerItem).resource) {
    // from remote explorer
    if (Array.isArray(items) && (items[0] as ExplorerItem).resource) {
      // multi-select in remote explorer
      return items.map(_ => _.resource.uri);
    } else {
      return item.resource.uri;
    }
  } else if (isScmResourceState(item)) {
    // from source control resource state context
    const selectedUris = uniqUris(
      args
        .reduce((all, value) => all.concat(asUriList(value)), [])
    );
    if (selectedUris.length > 0) {
      return selectedUris;
    }

    const uri = asUri(item);
    if (uri) {
      return uri;
    }
  }

  return;
}

// selected folder or configContext
export function selectFolderFallbackToConfigContext(item, items): Promise<undefined | Uri | Uri[]> {
  // from explorer or editor context
  if (item) {
    if (item instanceof Uri) {
      if (Array.isArray(items) && items[0] instanceof Uri) {
        // multi-select in explorer
        return Promise.resolve(items);
      } else {
        return Promise.resolve(item);
      }
    } else if ((item as ExplorerItem).resource) {
      // from remote explorer
      return Promise.resolve(item.resource.uri);
    }
  }

  return selectContext();
}

// selected file from all remote files
export const selectFileFromAll = createFileSelector();

// selected file from remote files expect ignored
export const selectFile = createFileSelector(configIngoreFilterCreator);
