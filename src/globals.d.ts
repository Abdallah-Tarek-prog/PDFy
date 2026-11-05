// Browser features the standard type files do not cover yet.

interface FilePickerType { description?: string; accept: Record<string, string[]> }

interface Window {
  showOpenFilePicker?(o?: { multiple?: boolean; types?: FilePickerType[]; excludeAcceptAllOption?: boolean }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(o?: { suggestedName?: string; types?: FilePickerType[] }): Promise<FileSystemFileHandle>;
  chrome?: { webview?: { postMessage(m: unknown): void; addEventListener(t: string, f: (e: { data: unknown; additionalObjects?: unknown[] }) => void): void } };
}

interface FileSystemHandle {
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}

interface Performance {
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
}
