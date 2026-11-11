package indexing

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/gob"
	"errors"
	"log/slog"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type pendingDelivery struct {
	Work, Empty, Authority     *catalog.PreparedWork
	Platform, Key, Fingerprint string
	Complete                   bool
	Bytes                      int64
}

func storedMessage(m message) pendingDelivery {
	return pendingDelivery{m.work, m.empty, m.authority, m.platform, m.key, m.fingerprint, m.complete, m.bytes}
}
func (m pendingDelivery) message() message {
	return message{work: m.Work, empty: m.Empty, authority: m.Authority, platform: m.Platform, key: m.Key, fingerprint: m.Fingerprint, complete: m.Complete, bytes: m.Bytes}
}

// HDD reading follows physical location. Future authors are spooled on the
// instance disk so display order need not force source seeks or unbounded RAM.
type deliveryQueue struct {
	p       *Pipeline
	ctx     context.Context
	listing *library.Listing
	output  chan<- message
}

func newDeliveryQueue(ctx context.Context, p *Pipeline, l *library.Listing, output chan<- message) (*deliveryQueue, error) {
	_, err := l.DB.ExecContext(ctx, `CREATE TABLE pending_delivery(ordinal INTEGER PRIMARY KEY,platform TEXT,author TEXT,payload BLOB);
CREATE INDEX pending_author ON pending_delivery(platform,author,ordinal);
CREATE INDEX pending_platform ON pending_delivery(platform,ordinal);
CREATE TABLE author_delivery(platform TEXT,key TEXT,rank INTEGER,done INTEGER DEFAULT 0,PRIMARY KEY(platform,key));
CREATE INDEX author_delivery_head ON author_delivery(platform,done,rank);`)
	if err != nil {
		return nil, err
	}
	for _, id := range p.selected {
		if cap(p.disks[p.Config.Sources[id]]) != 1 {
			continue
		}
		started := time.Now()
		if _, err = l.DB.ExecContext(ctx, `INSERT INTO author_delivery(platform,key,rank)
SELECT e.platform,e.key,row_number() OVER(ORDER BY (
 SELECT count(*) FROM entries w INDEXED BY entries_parent WHERE w.platform=e.platform AND w.parent=e.key AND w.kind='folder'
),e.key)
FROM entries e INDEXED BY entries_parent
WHERE e.platform=? AND e.parent='.' AND e.kind='folder' AND (?='' OR e.key=lower(?))`, id, p.AuthorDirectoryName, p.AuthorDirectoryName); err != nil {
			return nil, err
		}
		slog.InfoContext(ctx, "作者入库顺序已安排", "platform", id, "elapsedMs", time.Since(started).Milliseconds())
	}
	return &deliveryQueue{p, context.WithoutCancel(ctx), l, output}, nil
}

func (d *deliveryQueue) head(id string) (string, error) {
	ctx, l := d.ctx, d.listing
	var key string
	err := l.DB.QueryRowContext(ctx, "SELECT key FROM author_delivery WHERE platform=? AND done=0 ORDER BY rank LIMIT 1", id).Scan(&key)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return key, err
}

func (d *deliveryQueue) forward(m message) error {
	ctx, l := d.ctx, d.listing
	if m.work == nil && m.complete {
		_, err := l.DB.ExecContext(ctx, "UPDATE author_delivery SET done=1 WHERE platform=? AND key=?", m.platform, m.key)
		if err != nil {
			return err
		}
	}
	wait := time.Now()
	d.output <- m
	d.p.preparation[m.platform].DeliveryWait.Add(time.Since(wait).Nanoseconds())
	return nil
}

func (d *deliveryQueue) drain(id string, all bool) error {
	ctx, l, p := d.ctx, d.listing, d.p
	for {
		key, err := d.head(id)
		if err != nil {
			return err
		}
		query := "SELECT ordinal,payload FROM pending_delivery WHERE platform=?"
		args := []any{id}
		if !all {
			query += " AND author=?"
			args = append(args, key)
		}
		var ordinal int64
		var payload []byte
		at := time.Now()
		err = l.DB.QueryRowContext(ctx, query+" ORDER BY ordinal LIMIT 1", args...).Scan(&ordinal, &payload)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		var stored pendingDelivery
		if err = gob.NewDecoder(bytes.NewReader(payload)).Decode(&stored); err != nil {
			return err
		}
		p.preparation[id].Replay.Add(time.Since(at).Nanoseconds())
		if err = p.queueBudget.Acquire(ctx, stored.Bytes); err != nil {
			return err
		}
		if err = d.forward(stored.message()); err != nil {
			p.discardMessage(stored.message())
			return err
		}
		if _, err = l.DB.ExecContext(ctx, "DELETE FROM pending_delivery WHERE ordinal=?", ordinal); err != nil {
			return err
		}
	}
}

func (d *deliveryQueue) store(m message) error {
	author := m.key
	if m.work != nil {
		author = m.work.AuthorKey
	}
	ctx, l, p := d.ctx, d.listing, d.p
	at := time.Now()
	var encoded bytes.Buffer
	if err := gob.NewEncoder(&encoded).Encode(storedMessage(m)); err != nil {
		return err
	}
	if _, err := l.DB.ExecContext(ctx, "INSERT INTO pending_delivery(platform,author,payload) VALUES (?,?,?)", m.platform, author, encoded.Bytes()); err != nil {
		return err
	}
	p.queueBudget.Release(m.bytes)
	p.c.SpoolNanos.Add(time.Since(at).Nanoseconds())
	p.preparation[m.platform].Spool.Add(time.Since(at).Nanoseconds())
	return nil
}

func (p *Pipeline) discardMessage(m message) error {
	p.queueBudget.Release(m.bytes)
	if m.work != nil {
		return catalog.ReleasePrepared(*m.work)
	}
	return nil
}
func (d *deliveryQueue) accept(m message) (result error) {
	defer func() {
		if result != nil {
			result = errors.Join(result, d.p.discardMessage(m))
		}
	}()
	if cap(d.p.disks[d.p.Config.Sources[m.platform]]) != 1 {
		return d.forward(m)
	}
	if m.finished != nil {
		if err := d.drain(m.platform, true); err != nil {
			return err
		}
		d.output <- m
		return nil
	}
	author := m.key
	if m.work != nil {
		author = m.work.AuthorKey
	}
	key, err := d.head(m.platform)
	if err != nil {
		return err
	}
	if author == key || key == "" {
		if err = d.forward(m); err != nil {
			return err
		}
		m.bytes = 0
		m.work = nil
		if err = d.drain(m.platform, false); err != nil {
			return err
		}
		return nil
	}
	return d.store(m)
}

func (p *Pipeline) orderMessages(ctx context.Context, l *library.Listing, input <-chan message, output chan<- message) error {
	d, err := newDeliveryQueue(ctx, p, l, output)
	if err != nil {
		return err
	}
	for m := range input {
		if err = d.accept(m); err != nil {
			return err
		}
	}
	for _, id := range p.selected {
		if err = d.drain(id, true); err != nil {
			return err
		}
	}
	return nil
}
