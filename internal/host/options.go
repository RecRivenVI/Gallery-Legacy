// Package host assembles the manager-owned Go service and tasks.
package host

type Row = map[string]any
type Options struct{ ConfigFile, Frontend, Assets string }

func errorField(r Row, fallback string) string {
	if code, ok := r["code"].(string); ok {
		return code
	}
	return fallback
}
