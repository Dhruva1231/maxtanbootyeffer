-- Missed-chore reports for rayaboy.com/chores (separate "chores" InsForge
-- project; nothing here touches the Rayaboy product's backend).
--
-- Honor system: there are no logins. Anyone with the page can read the board,
-- and all writes go through the three functions below, which enforce the
-- house rules. The tables themselves are read-only to the public roles.
--
-- Rules:
--   * Anyone can report another pair for a missed task. You can't report your
--     own pair. The missed day must be between last Saturday and today (LA
--     time); Mon-Fri misses are due that Saturday, Sat/Sun misses the next.
--   * A report counts unless a member of the reported pair disputes it AND a
--     third roommate (not the reporter, not in the pair) sides with them.
--   * The reporter can withdraw their own report.

CREATE TABLE public.chore_people (
  name text PRIMARY KEY,
  pair_id text NOT NULL
);

-- Keep in sync with public/chores/chores.config.json (pairs).
INSERT INTO public.chore_people (name, pair_id) VALUES
  ('Josh', 'josh-darren'), ('Darren', 'josh-darren'),
  ('Dhruva', 'dhruva-ashish'), ('Ashish', 'dhruva-ashish'),
  ('Ethan', 'ethan-nimal'), ('Nimal', 'ethan-nimal'),
  ('Matt', 'matt-dylan'), ('Dylan', 'matt-dylan');

CREATE TABLE public.chore_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_id text NOT NULL,
  task text NOT NULL CHECK (char_length(task) BETWEEN 1 AND 120),
  missed_on date NOT NULL,
  reporter text NOT NULL REFERENCES public.chore_people (name),
  note text CHECK (note IS NULL OR char_length(note) <= 280),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);

-- One live report per pair, task and day.
CREATE UNIQUE INDEX chore_reports_one_live
  ON public.chore_reports (pair_id, task, missed_on)
  WHERE withdrawn_at IS NULL;
CREATE INDEX chore_reports_missed_on ON public.chore_reports (missed_on);

CREATE TABLE public.chore_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES public.chore_reports (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('dispute', 'side')),
  voter text NOT NULL REFERENCES public.chore_people (name),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, kind)
);

-- Public roles may read everything but write nothing directly.
ALTER TABLE public.chore_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chore_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chore_votes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.chore_people, public.chore_reports, public.chore_votes FROM anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.chore_people, public.chore_reports, public.chore_votes TO anon, authenticated;

CREATE POLICY chore_people_read ON public.chore_people FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY chore_reports_read ON public.chore_reports FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY chore_votes_read ON public.chore_votes FOR SELECT TO anon, authenticated USING (true);

-- Earliest reportable day: the Saturday before this week's Monday (LA time).
CREATE FUNCTION public.chore_window_start() RETURNS date
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT date_trunc('week', (now() AT TIME ZONE 'America/Los_Angeles')::date)::date - 2
$$;

CREATE FUNCTION public.chore_report(
  p_reporter text, p_pair_id text, p_task text, p_missed_on date, p_note text DEFAULT NULL
) RETURNS public.chore_reports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  reporter_pair text;
  today date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  result public.chore_reports;
BEGIN
  SELECT pair_id INTO reporter_pair FROM chore_people WHERE name = p_reporter;
  IF reporter_pair IS NULL THEN RAISE EXCEPTION 'Pick your name first.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM chore_people WHERE pair_id = p_pair_id) THEN
    RAISE EXCEPTION 'Unknown pair.';
  END IF;
  IF reporter_pair = p_pair_id THEN RAISE EXCEPTION 'You can''t report your own pair.'; END IF;
  IF p_missed_on IS NULL OR p_missed_on < chore_window_start() OR p_missed_on > today THEN
    RAISE EXCEPTION 'Pick a day between last Saturday and today.';
  END IF;

  INSERT INTO chore_reports (pair_id, task, missed_on, reporter, note)
  VALUES (p_pair_id, btrim(p_task), p_missed_on, p_reporter, NULLIF(btrim(p_note), ''))
  RETURNING * INTO result;
  RETURN result;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'That task is already reported for that day.';
END;
$$;

CREATE FUNCTION public.chore_vote(p_report_id uuid, p_voter text, p_kind text)
RETURNS public.chore_votes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  report public.chore_reports;
  voter_pair text;
  result public.chore_votes;
BEGIN
  SELECT * INTO report FROM chore_reports WHERE id = p_report_id;
  IF report.id IS NULL OR report.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'That report is gone.'; END IF;
  IF report.missed_on < chore_window_start() THEN RAISE EXCEPTION 'That report is closed.'; END IF;
  SELECT pair_id INTO voter_pair FROM chore_people WHERE name = p_voter;
  IF voter_pair IS NULL THEN RAISE EXCEPTION 'Pick your name first.'; END IF;

  IF p_kind = 'dispute' THEN
    IF voter_pair <> report.pair_id THEN RAISE EXCEPTION 'Only the reported pair can dispute.'; END IF;
  ELSIF p_kind = 'side' THEN
    IF voter_pair = report.pair_id OR p_voter = report.reporter THEN
      RAISE EXCEPTION 'Only someone outside the pair who didn''t report it can decide.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM chore_votes WHERE report_id = p_report_id AND kind = 'dispute') THEN
      RAISE EXCEPTION 'Nobody has disputed this report.';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown vote.';
  END IF;

  INSERT INTO chore_votes (report_id, kind, voter) VALUES (p_report_id, p_kind, p_voter)
  RETURNING * INTO result;
  RETURN result;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Someone already did that.';
END;
$$;

CREATE FUNCTION public.chore_withdraw(p_report_id uuid, p_reporter text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE chore_reports SET withdrawn_at = now()
  WHERE id = p_report_id AND reporter = p_reporter AND withdrawn_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only the person who reported it can withdraw it.'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.chore_report(text, text, text, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.chore_vote(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.chore_withdraw(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chore_report(text, text, text, date, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chore_vote(uuid, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chore_withdraw(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chore_window_start() TO anon, authenticated;
