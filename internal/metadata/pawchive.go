package metadata

import (
	"strings"
)

func pawchive(r *Result, m Object, author, work string) {
	parts := strings.SplitN(author, "_", 2)
	service := String(m["service"])
	user := ID(Or(m["user"], Get(m, "user_profile.id")))
	if len(parts) == 2 {
		if service != "" && service != parts[0] {
			r.Valid = false
			r.Reason = "service_identity_conflict"
		} else {
			service = parts[0]
			if user == nil {
				user = parts[1]
			}
		}
	}
	id := ID(m["id"])
	if id == nil {
		id = DirectoryWorkID(work)
		if id == nil {
			id = work
		}
	}
	if r.Valid && service != "" {
		r.Work["sourceWorkId"] = service + ":" + String(id)
		if user != nil {
			r.Profile["sourceAuthorId"] = service + ":" + String(user)
		}
	}
}
