import { DataSource } from "typeorm";
import { ensureDirForFile } from "./fs";

export const ensureSqliteDataSource = async (dataSource: DataSource) => {
  const db = dataSource.options.database as string;
  if (!db) throw new Error("SQLite database path is required");
  await ensureDirForFile(db);
  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }
  return dataSource;
};
