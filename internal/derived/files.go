// Package derived removes only application-owned derived and temporary files.
// Agent workspace cleanup follows the separate workspace Recycle Bin policy.
package derived

import "os"

func Remove(path string) error { return os.RemoveAll(path) }
