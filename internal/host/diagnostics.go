package host

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/dataset"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

func diagnose(ctx context.Context, c instance.Config, file string) (any, error) {
	checks, findings := []Row{}, []Row{}
	for _, p := range c.Platforms {
		st, err := os.Stat(p.PhysicalRoot)
		ok := err == nil && st.IsDir() && library.NoLinks(p.PhysicalRoot) == nil
		checks = append(checks, Row{"platform": p.ID, "available": ok})
		if !ok {
			findings = append(findings, Row{"code": "SOURCE_UNAVAILABLE", "platform": p.ID})
		}
	}
	for _, tool := range []string{"ffmpeg", "magick"} {
		commandCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		command := exec.CommandContext(commandCtx, tool, "-version")
		command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		ok := command.Run() == nil
		cancel()
		checks = append(checks, Row{"tool": tool, "available": ok})
		if !ok {
			findings = append(findings, Row{"code": "MEDIA_TOOL_UNAVAILABLE", "tool": tool})
		}
	}
	d, err := dataset.Load(ctx, file)
	if err != nil {
		findings = append(findings, Row{"code": control.Code(err, "GENERATION_INVALID")})
	} else {
		state, e := d.State(ctx)
		d.Close()
		if e != nil {
			findings = append(findings, Row{"code": control.Code(e, "GENERATION_INVALID")})
		} else {
			counts := state["counts"].(map[string]any)
			row := Row{"generation": d.Epoch, "valid": true, "works": counts["works"], "counts": counts}
			if live, ok := state["live"]; ok {
				b := stringsJSON(live)
				var m Row
				_ = json.Unmarshal([]byte(b), &m)
				row["revision"] = m["revision"]
			}
			checks = append(checks, row)
		}
	}
	state := "PASS"
	if len(findings) > 0 {
		state = "ISSUES"
	}
	report := Row{"atMs": timestamp(), "state": state, "checks": checks, "findings": findings, "privacy": "aggregate only"}
	name := fmt.Sprintf("manager-diagnostics-%d.json", timestamp())
	report["report"] = name
	return report, instance.WriteJSON(filepath.Join(c.ReportsRoot, name), report)
}
