import { contextBridge, ipcRenderer } from "electron";
import type { RepositoryTarget } from "../gitService";

contextBridge.exposeInMainWorld("trellisUI", {
  detect: (repository: RepositoryTarget) => ipcRenderer.invoke("trellis:detect", repository),
  getOverview: (repository: RepositoryTarget) => ipcRenderer.invoke("trellis:getOverview", repository),
  listTasks: (repository: RepositoryTarget) => ipcRenderer.invoke("trellis:listTasks", repository),
  getTask: (repository: RepositoryTarget, dirName: string) => ipcRenderer.invoke("trellis:getTask", repository, dirName),
  getReview: (repository: RepositoryTarget, dirName: string) => ipcRenderer.invoke("trellis:getReview", repository, dirName),
  getSpecTree: (repository: RepositoryTarget) => ipcRenderer.invoke("trellis:getSpecTree", repository),
  getSpecFile: (repository: RepositoryTarget, relativePath: string) => ipcRenderer.invoke("trellis:getSpecFile", repository, relativePath)
});
