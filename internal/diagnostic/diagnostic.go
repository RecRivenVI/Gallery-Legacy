// Package diagnostic holds the process-wide opt-in for developer sampling.
package diagnostic

import "os"

var Enabled = os.Getenv("GALLERY_DIAGNOSTICS") == "1"
