package catalog

import "strings"

type insertKey struct{ table, conflict string }
type insertPlan struct {
	columns []string
	query   string
}
type insertPlanCache struct {
	count  int
	groups map[insertKey][]*insertPlan
}

// Only schema column names and SQL are retained, never row values or IDs.
// Presence checks distinguish an absent key from an explicitly bound NULL.
// A plan survives rollback because it contains no transactional state.
func (c *insertPlanCache) plan(table, conflict string, r Row) *insertPlan {
	key := insertKey{table, conflict}
	for _, p := range c.groups[key] {
		if len(p.columns) != len(r) {
			continue
		}
		match := true
		for _, column := range p.columns {
			if _, ok := r[column]; !ok {
				match = false
				break
			}
		}
		if match {
			return p
		}
	}
	columns := SortedKeys(r)
	marks := make([]string, len(columns))
	updates := []string{}
	primary := map[string]string{"works": "work_id", "authors": "author_id", "media": "media_id", "tags": "tag_id"}[table]
	for i, k := range columns {
		marks[i] = "?"
		if conflict != "" && k != primary {
			updates = append(updates, k+"=excluded."+k)
		}
	}
	query := "INSERT INTO " + table + "(" + strings.Join(columns, ",") + ") VALUES (" + strings.Join(marks, ",") + ")"
	if conflict != "" {
		if len(updates) == 0 {
			query += " ON CONFLICT(" + conflict + ") DO NOTHING"
		} else {
			query += " ON CONFLICT(" + conflict + ") DO UPDATE SET " + strings.Join(updates, ",")
		}
	}
	p := &insertPlan{columns, query}
	if c.count < 128 {
		if c.groups == nil {
			c.groups = map[insertKey][]*insertPlan{}
		}
		c.groups[key] = append(c.groups[key], p)
		c.count++
	}
	return p
}
