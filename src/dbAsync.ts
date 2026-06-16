import * as db from './db.js';
import type { AtlasFileRecord, AtlasFileWitnessRecord } from './types.js';

export async function getAtlasFileAsync(workspace: string, filePath: string): Promise<AtlasFileRecord | null> {
  return db.getAtlasFile(workspace, filePath);
}

export async function listAtlasFilesAsync(workspace: string): Promise<AtlasFileRecord[]> {
  return db.listAtlasFiles(workspace);
}

export async function lookupSnapshotAsync(workspace: string, filePath: string, at: string | null): Promise<string | null> {
  return db.lookupSnapshot(workspace, filePath, at);
}

export async function lookupSnapshotRecordAsync(workspace: string, filePath: string, at: string | null): Promise<any> {
  return db.lookupSnapshotRecord(workspace, filePath, at);
}

export async function listClusterFilesAsync(workspace: string, cluster: string | null): Promise<AtlasFileRecord[]> {
  return db.listClusterFiles(workspace, cluster);
}

export async function listPatternFilesAsync(workspace: string, pattern: string): Promise<AtlasFileRecord[]> {
  return db.listPatternFiles(workspace, pattern);
}

export async function aggregatePatternCountsAsync(workspace: string): Promise<any[]> {
  return db.aggregatePatternCounts(workspace);
}

export async function countDistinctPatternsAsync(workspace: string): Promise<number> {
  return db.countDistinctPatterns(workspace);
}

export async function listAtlasFileWitnessesAsync(workspace: string, filePath: string): Promise<AtlasFileWitnessRecord[]> {
  return db.listAtlasFileWitnesses(workspace, filePath);
}

export async function listSymbolIdentitiesAsync(workspace: string, filePath: string): Promise<any[]> {
  return db.listSymbolIdentities(workspace, filePath);
}

export async function listImportsAsync(workspace: string, filePath: string): Promise<any[]> {
  return db.listImports(workspace, filePath);
}

export async function listImportedByAsync(workspace: string, filePath: string): Promise<any[]> {
  return db.listImportedBy(workspace, filePath);
}

export async function listImportEdgesAsync(workspace: string): Promise<any[]> {
  return db.listImportEdges(workspace);
}

export async function listSymbolsAsync(workspace: string, filePath: string): Promise<any[]> {
  return db.listSymbols(workspace, filePath);
}

export async function listReferencesAsync(workspace: string, filePath: string): Promise<any[]> {
  return db.listReferences(workspace, filePath);
}

export async function searchFtsAsync(workspace: string, query: string, limit?: number): Promise<any[]> {
  return db.searchFts(workspace, query, limit);
}

export async function searchAtlasFilesAsync(workspace: string, query: string, limit?: number): Promise<any[]> {
  return db.searchAtlasFiles(workspace, query, limit);
}

export async function searchVectorAsync(workspace: string, embedding: number[], limit?: number): Promise<any[]> {
  return db.searchVector(workspace, embedding, limit);
}

export async function getAtlasEmbeddingAsync(workspace: string, key: string, model: string): Promise<number[] | null> {
  return db.getAtlasEmbedding(workspace, key, model);
}

export async function queryAtlasChangelogAsync(workspace: string, query: any): Promise<any[]> {
  return db.queryAtlasChangelog(workspace, query);
}

export async function countAtlasChangelogAsync(workspace: string, query: any): Promise<number> {
  return db.countAtlasChangelog(workspace, query);
}

export async function groupAtlasChangelogAsync(workspace: string, query: any): Promise<any[]> {
  return db.groupAtlasChangelog(workspace, query);
}

export async function countAtlasChangelogGroupsAsync(workspace: string, query: any): Promise<number> {
  return db.countAtlasChangelogGroups(workspace, query);
}

export async function timelineAtlasChangelogAsync(workspace: string, query: any): Promise<any[]> {
  return db.timelineAtlasChangelog(workspace, query);
}

export async function getFilePhaseAsync(workspace: string, filePath: string): Promise<number> {
  return db.getFilePhase(workspace, filePath);
}

export async function atlasCrossrefCountAsync(workspace: string): Promise<number> {
  return db.atlasCrossrefCount(workspace);
}

export async function deleteAtlasFileAsync(workspace: string, filePath: string): Promise<void> {
  return db.deleteAtlasFile(workspace, filePath);
}

export async function enqueueReextractAsync(workspace: string, filePath: string): Promise<void> {
  return db.enqueueReextract(workspace, filePath);
}

export async function upsertFileRecordAsync(workspace: string, file: any): Promise<void> {
  return db.upsertFileRecord(workspace, file);
}

export async function insertAtlasChangelogAsync(workspace: string, changelog: any): Promise<number> {
  return db.insertAtlasChangelog(workspace, changelog);
}

export async function markChangelogVerificationAsync(workspace: string, changelogId: number, status: string, evidence: string): Promise<void> {
  return db.markChangelogVerification(workspace, changelogId, status, evidence);
}

export async function insertSnapshotAsync(workspace: string, filePath: string, content: string, hash: string): Promise<void> {
  return db.insertSnapshot(workspace, filePath, content, hash);
}

export async function pruneSnapshotsAsync(workspace: string, filePath: string, keepLimit?: number): Promise<void> {
  return db.pruneSnapshots(workspace, filePath, keepLimit);
}

export async function commitChangelogBatchAsync(workspace: string, changelog: any, snapshots: any[], files: any[], symbolIdentities: any[]): Promise<any> {
  return db.commitChangelogBatch(workspace, changelog, snapshots, files, symbolIdentities);
}
