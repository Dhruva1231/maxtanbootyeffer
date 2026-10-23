-- Personal PINs: every report, dispute, side vote and withdrawal must come
-- with the acting roommate's PIN, so people can't act as each other.
--
-- * Each roommate sets their own 4-6 digit PIN the first time they pick
--   their name (chore_set_pin). It's stored as a bcrypt hash (pgcrypto).
-- * Five wrong PINs lock that name for 15 minutes.
-- * To reset someone's PIN, run as the project owner:
--     UPDATE chore_people SET pin_hash = NULL, failed_attempts = 0, locked_until = NULL WHERE name = 'Josh';
--
-- A wrong PIN is reported as {"error": ...} instead of an exception so the
-- failed-attempt counter is saved (an exception would roll it back). Other
-- rule violations still raise, as before.

ALTER TABLE public.chore_people
  ADD COLUMN pin_hash text,
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz;

-- The public key may read names and pairs, never the PIN columns.
REVOKE SELECT ON public.chore_people FROM anon, authenticated;
GRANT SELECT (name, pair_id) ON public.chore_people TO anon, authenticated;

-- Who has set a PIN yet (so the page knows whether to ask for a new one).
CREATE FUNCTION public.chore_people_status()
RETURNS TABLE (name text, pair_id text, has_pin boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT name, pair_id, pin_hash IS NOT NULL FROM chore_people ORDER BY name
$$;

-- NULL if the PIN is right; otherwise the message to show. Not callable by
-- the public key; only the functions below use it.
CREATE FUNCTION public.chore_pin_problem(p_name text, p_pin text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  person public.chore_people;
BEGIN
  SELECT * INTO person FROM chore_people WHERE name = p_name FOR UPDATE;
  IF person.name IS NULL THEN RETURN 'Pick your name first.'; END IF;
  IF person.pin_hash IS NULL THEN RETURN 'Set your PIN first.'; END IF;
  IF person.locked_until > now() THEN
    RETURN format('Too many wrong PINs. Try again in %s min.', ceil(extract(epoch FROM person.locked_until - now()) / 60));
  END IF;
  IF p_pin IS NOT NULL AND crypt(p_pin, person.pin_hash) = person.pin_hash THEN
    UPDATE chore_people SET failed_attempts = 0, locked_until = NULL WHERE name = p_name;
    RETURN NULL;
  END IF;
  IF person.failed_attempts + 1 >= 5 THEN
    UPDATE chore_people SET failed_attempts = 0, locked_until = now() + interval '15 minutes' WHERE name = p_name;
    RETURN 'Wrong PIN. Too many tries, so this name is locked for 15 min.';
  END IF;
  UPDATE chore_people SET failed_attempts = failed_attempts + 1 WHERE name = p_name;
  RETURN 'Wrong PIN.';
END;
$$;

CREATE FUNCTION public.chore_set_pin(p_name text, p_pin text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_pin IS NULL OR p_pin !~ '^[0-9]{4,6}$' THEN RETURN jsonb_build_object('error', 'Use 4 to 6 digits.'); END IF;
  UPDATE chore_people SET pin_hash = crypt(p_pin, gen_salt('bf')), failed_attempts = 0, locked_until = NULL
  WHERE name = p_name AND pin_hash IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'That name already has a PIN. Enter it instead, or ask for a reset.');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE FUNCTION public.chore_login(p_name text, p_pin text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  problem text := chore_pin_problem(p_name, p_pin);
BEGIN
  IF problem IS NOT NULL THEN RETURN jsonb_build_object('error', problem); END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- The actions now take the PIN. Old signatures are dropped.
DROP FUNCTION public.chore_report(text, text, text);
DROP FUNCTION public.chore_vote(uuid, text, text);
DROP FUNCTION public.chore_withdraw(uuid, text);

CREATE FUNCTION public.chore_report(p_reporter text, p_pin text, p_pair_id text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  problem text := chore_pin_problem(p_reporter, p_pin);
  reporter_pair text;
  new_id uuid;
BEGIN
  IF problem IS NOT NULL THEN RETURN jsonb_build_object('error', problem); END IF;
  SELECT pair_id INTO reporter_pair FROM chore_people WHERE name = p_reporter;
  IF NOT EXISTS (SELECT 1 FROM chore_people WHERE pair_id = p_pair_id) THEN RAISE EXCEPTION 'Unknown pair.'; END IF;
  IF reporter_pair = p_pair_id THEN RAISE EXCEPTION 'You can''t report your own pair.'; END IF;
  BEGIN
    INSERT INTO chore_reports (pair_id, missed_on, reporter, note)
    VALUES (p_pair_id, (now() AT TIME ZONE 'America/Los_Angeles')::date, p_reporter, NULLIF(btrim(p_note), ''))
    RETURNING id INTO new_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'That pair has already been reported today.';
  END;
  RETURN jsonb_build_object('ok', true, 'id', new_id);
END;
$$;

CREATE FUNCTION public.chore_vote(p_report_id uuid, p_voter text, p_pin text, p_kind text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  problem text := chore_pin_problem(p_voter, p_pin);
  report public.chore_reports;
  voter_pair text;
BEGIN
  IF problem IS NOT NULL THEN RETURN jsonb_build_object('error', problem); END IF;
  SELECT * INTO report FROM chore_reports WHERE id = p_report_id;
  IF report.id IS NULL OR report.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'That report is gone.'; END IF;
  IF report.missed_on < chore_window_start() THEN RAISE EXCEPTION 'That report is closed.'; END IF;
  SELECT pair_id INTO voter_pair FROM chore_people WHERE name = p_voter;

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

  BEGIN
    INSERT INTO chore_votes (report_id, kind, voter) VALUES (p_report_id, p_kind, p_voter);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Someone already did that.';
  END;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE FUNCTION public.chore_withdraw(p_report_id uuid, p_reporter text, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  problem text := chore_pin_problem(p_reporter, p_pin);
BEGIN
  IF problem IS NOT NULL THEN RETURN jsonb_build_object('error', problem); END IF;
  UPDATE chore_reports SET withdrawn_at = now()
  WHERE id = p_report_id AND reporter = p_reporter AND withdrawn_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only the person who reported it can withdraw it.'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.chore_pin_problem(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chore_people_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.chore_set_pin(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.chore_login(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.chore_report(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.chore_vote(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.chore_withdraw(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chore_people_status() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chore_set_pin(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chore_login(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chore_report(text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chore_vote(uuid, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chore_withdraw(uuid, text, text) TO anon, authenticated;
