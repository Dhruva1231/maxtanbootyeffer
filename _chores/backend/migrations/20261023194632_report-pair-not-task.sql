-- Reports are now "this pair missed a chore today": no task, no day picker.
-- The punishment is the same whichever task was missed, so a report names
-- only the pair, and each pair can be reported at most once per day.

DROP INDEX public.chore_reports_one_live;
ALTER TABLE public.chore_reports ALTER COLUMN task DROP NOT NULL;
CREATE UNIQUE INDEX chore_reports_one_live_per_day
  ON public.chore_reports (pair_id, missed_on)
  WHERE withdrawn_at IS NULL;

DROP FUNCTION public.chore_report(text, text, text, date, text);

CREATE FUNCTION public.chore_report(p_reporter text, p_pair_id text, p_note text DEFAULT NULL)
RETURNS public.chore_reports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  reporter_pair text;
  result public.chore_reports;
BEGIN
  SELECT pair_id INTO reporter_pair FROM chore_people WHERE name = p_reporter;
  IF reporter_pair IS NULL THEN RAISE EXCEPTION 'Pick your name first.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM chore_people WHERE pair_id = p_pair_id) THEN
    RAISE EXCEPTION 'Unknown pair.';
  END IF;
  IF reporter_pair = p_pair_id THEN RAISE EXCEPTION 'You can''t report your own pair.'; END IF;

  INSERT INTO chore_reports (pair_id, missed_on, reporter, note)
  VALUES (p_pair_id, (now() AT TIME ZONE 'America/Los_Angeles')::date, p_reporter, NULLIF(btrim(p_note), ''))
  RETURNING * INTO result;
  RETURN result;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'That pair has already been reported today.';
END;
$$;

REVOKE ALL ON FUNCTION public.chore_report(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chore_report(text, text, text) TO anon, authenticated;
