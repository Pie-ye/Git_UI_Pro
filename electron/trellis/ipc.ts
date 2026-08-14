import { ipcMain } from "electron";
import type { RepositoryLocation } from "../gitService";
import { TrellisService } from "./service";

let registered = false;

export function registerTrellisIpc(service = new TrellisService()): void {
  if (registered) {
    return;
  }
  registered = true;

  ipcMain.handle("trellis:detect", (_event, repository: RepositoryLocation) => service.detect(repository));
  ipcMain.handle("trellis:getOverview", (_event, repository: RepositoryLocation) => service.getOverview(repository));
  ipcMain.handle("trellis:listTasks", (_event, repository: RepositoryLocation) => service.listTasks(repository));
  ipcMain.handle("trellis:getTask", (_event, repository: RepositoryLocation, dirName: string) => service.getTask(repository, dirName));
  ipcMain.handle("trellis:getReview", (_event, repository: RepositoryLocation, dirName: string) => service.getReview(repository, dirName));
  ipcMain.handle("trellis:getSpecTree", (_event, repository: RepositoryLocation) => service.getSpecTree(repository));
  ipcMain.handle("trellis:getSpecFile", (_event, repository: RepositoryLocation, relativePath: string) => service.getSpecFile(repository, relativePath));
}
