import { Db, MongoClient } from "mongodb";

const globalForMongo = globalThis as typeof globalThis & {
  _mongoClient?: Promise<MongoClient>;
  _jovoDb?: Promise<Db>;
};

export async function db(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required to use the database.");
  }

  globalForMongo._mongoClient ??= new MongoClient(uri).connect();
  globalForMongo._jovoDb ??= globalForMongo._mongoClient.then(async (client) => {
    const database = client.db(process.env.MONGODB_DB ?? "jovo");
    await database.collection("links").createIndex({ sender: 1, createdAt: -1 });
    return database;
  });

  return globalForMongo._jovoDb;
}

export type LinkDoc = {
  _id: string;
  sender: string;
  token: string;
  amount: string;
  expiresAt: number;
  memo?: string;
  createTxHash: string;
  createdAt: Date;
  claimTxHash?: string;
  claimedBy?: string;
  claimedAt?: Date;
};
