"use strict";

function compareInteger(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createAffectedCounts() {
  return {
    authorIds: new Set(),
    tagIds: new Set(),
    shapeIds: new Set(),
  };
}

function assertAffectedCounts(affected) {
  if (!affected || !(affected.authorIds instanceof Set) || !(affected.tagIds instanceof Set)
    || !(affected.shapeIds instanceof Set)) {
    throw new TypeError("Affected Catalog counts require authorIds/tagIds/shapeIds Sets");
  }
  return affected;
}

function collectWorkCountIdentities(db, workId, affected) {
  assertAffectedCounts(affected);
  const work = db.prepare("SELECT author_id,metadata_shape_id FROM works WHERE work_id=?").get(workId);
  if (!work) return false;
  affected.authorIds.add(work.author_id);
  if (work.metadata_shape_id !== null) affected.shapeIds.add(work.metadata_shape_id);
  for (const row of db.prepare("SELECT tag_id FROM work_tags WHERE work_id=?").all(workId)) affected.tagIds.add(row.tag_id);
  return true;
}

function recountAffectedCounts(db, affected) {
  assertAffectedCounts(affected);
  const updateAuthor = db.prepare("UPDATE authors SET work_count=(SELECT count(*) FROM works WHERE author_id=?) WHERE author_id=?");
  for (const authorId of [...affected.authorIds].sort(compareInteger)) updateAuthor.run(authorId, authorId);
  const updateTag = db.prepare("UPDATE tags SET work_count=(SELECT count(*) FROM work_tags WHERE tag_id=?) WHERE tag_id=?");
  for (const tagId of [...affected.tagIds].sort(compareInteger)) updateTag.run(tagId, tagId);
  const updateShape = db.prepare("UPDATE metadata_shapes SET work_count=(SELECT count(*) FROM works WHERE metadata_shape_id=?) WHERE metadata_shape_id=?");
  for (const shapeId of [...affected.shapeIds].sort(compareInteger)) updateShape.run(shapeId, shapeId);
}

function affectedCountMismatches(db, affected) {
  assertAffectedCounts(affected);
  const mismatches = [];
  const checks = [
    ["author", affected.authorIds, db.prepare(`SELECT work_count AS stored,
      (SELECT count(*) FROM works WHERE author_id=authors.author_id) AS actual FROM authors WHERE author_id=?`)],
    ["tag", affected.tagIds, db.prepare(`SELECT work_count AS stored,
      (SELECT count(*) FROM work_tags WHERE tag_id=tags.tag_id) AS actual FROM tags WHERE tag_id=?`)],
    ["shape", affected.shapeIds, db.prepare(`SELECT work_count AS stored,
      (SELECT count(*) FROM works WHERE metadata_shape_id=metadata_shapes.metadata_shape_id) AS actual
      FROM metadata_shapes WHERE metadata_shape_id=?`)],
  ];
  for (const [kind, ids, statement] of checks) {
    for (const id of [...ids].sort(compareInteger)) {
      const row = statement.get(id);
      if (row && row.stored !== row.actual) mismatches.push({ kind, id, stored: row.stored, actual: row.actual });
    }
  }
  return mismatches;
}

module.exports = {
  affectedCountMismatches,
  collectWorkCountIdentities,
  createAffectedCounts,
  recountAffectedCounts,
};
