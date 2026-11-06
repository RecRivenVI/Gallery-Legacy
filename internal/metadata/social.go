package metadata

func socialProfile(r *Result, m Object, platform string) {
	u := Obj(m["user"])
	a := Obj(m["author"])
	pick := func(k string) any {
		if v, ok := u[k]; ok && v != nil {
			return v
		}
		return a[k]
	}
	if platform == "X" {
		r.Profile["location"] = Str(Or(u["location"], a["location"]))
		r.Profile["avatarUrl"] = HTTP(Or(u["profile_image"], a["profile_image"]))
		r.Profile["bannerUrl"] = HTTP(Or(u["profile_banner"], a["profile_banner"]))
		r.Profile["profileUrl"] = HTTP(Or(u["url"], a["url"]))
		r.Profile["followingCount"] = Integer(pick("friends_count"), true)
	} else {
		r.Profile["avatarUrl"] = HTTP(Or(u["avatar_hd"], u["avatar_large"], u["profile_image_url"]))
		r.Profile["profileUrl"] = Str(u["profile_url"])
		r.Profile["location"] = Str(u["location"])
		r.Profile["verificationType"] = Integer(u["verified_type"], true)
		r.Profile["verificationReason"] = Str(u["verified_reason"])
		r.Profile["followingCount"] = Integer(Or(u["follow_count"], u["friends_count"]), true)
	}
	r.Profile["language"] = Str(pick("lang"))
	r.Profile["verified"] = Bool(pick("verified"))
	r.Profile["followersCount"] = Integer(pick("followers_count"), true)
	r.Profile["statusesCount"] = Integer(pick("statuses_count"), true)
}
