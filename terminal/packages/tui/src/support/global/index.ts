import path from "path"
import os from "os"
import { Filesystem } from "../util/filesystem"

export class Global {
  cwd = process.cwd()
  fs = new Filesystem()

  static Path = {
    home: os.homedir(),
    config: path.join(os.homedir(), ".config", "eidolon"),
    data: path.join(os.homedir(), ".local", "share", "eidolon"),
    cache: path.join(os.homedir(), ".cache", "eidolon"),
    state: path.join(os.homedir(), ".local", "state", "eidolon"),
  }
}
