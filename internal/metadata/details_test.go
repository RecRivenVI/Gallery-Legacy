package metadata

import "testing"

func TestExpandedPlatformFields(t *testing.T) {
	r, _ := Parse("pixiv", "7", "1", []byte(`{"id":"1","user":{"id":"7"},"type":"manga","x_restrict":2,"series":{"id":44,"title":"序列"},"tools":["ink"],"total_view":123,"total_comments":9}`))
	if r.Details.WorkType != "manga" || r.Details.Rating == nil || *r.Details.Rating != 2 || r.Details.SeriesID != "44" || len(r.Details.Tools) != 1 || r.Metrics["views"] != int64(123) {
		t.Fatalf("pixiv details: %+v", r)
	}
	r, _ = Parse("pixivFANBOX", "7", "1", []byte(`{"id":"1","user":{"userId":"7","profileLinks":["https://example.test/"]},"type":"article","plan":{"title":"月","fee":500},"prevPost":{"id":"0","title":"前"},"nextPost":{"id":"2","title":"次"}}`))
	if r.Details.PlanName != "月" || r.Details.Next.ID != "2" || r.AuthorLinks[0] != (AuthorLink{Platform: "pixiv", SourceID: "7"}) {
		t.Fatalf("fanbox details: %+v", r)
	}
	r, _ = Parse("Patreon", "8", "1", []byte(`{"id":"1","creator":{"id":"8","social_connections":{"twitter":{"user_id":"77"}}},"post_type":"image_file"}`))
	if len(r.AuthorLinks) != 0 {
		t.Fatalf("patreon links: %+v", r.AuthorLinks)
	}
	r, _ = Parse("Fantia", "8", "1", []byte(`{"content_category":"photo","plan":{"name":"support","price":500}}`))
	if r.Details.WorkType != "photo" || r.Details.PlanFee == nil || *r.Details.PlanFee != 500 {
		t.Fatalf("fantia: %+v", r.Details)
	}
	r, _ = Parse("微博", "8", "1", []byte(`{"page_info":{"object_type":"video"},"region_name":"位置"}`))
	if r.Details.WorkType != "video" || r.Details.Region != "位置" || r.Details.Rating != nil {
		t.Fatalf("weibo: %+v", r.Details)
	}
}

func TestXQuoteAndConversation(t *testing.T) {
	r, _ := Parse("X", "7", "1", []byte(`{"tweet_id":"1","quote_id":"0","quoted_id":"2","conversation_id":"1","lang":"zh"}`))
	if len(r.Relations) != 1 || r.Relations[0] != (Relation{"quote", "2"}) || r.Work["language"] != "zh" {
		t.Fatalf("relations: %+v", r)
	}
	r, _ = Parse("X", "7", "3", []byte(`{"tweet_id":"3","conversation_id":"1"}`))
	if len(r.Relations) != 1 || r.Relations[0].Type != "conversation" {
		t.Fatalf("real conversation removed: %+v", r.Relations)
	}
}

func TestDescriptionPlainText(t *testing.T) {
	got := PlainText(`<p>甲&nbsp;&amp;乙</p><script>hidden()</script><p>https://example.test/<br>下一行</p>`, "html")
	if got != "甲\u00a0&乙\nhttps://example.test/\n下一行" {
		t.Fatalf("plain description: %q", got)
	}
}
