-- Money is not counted in whole cents here.
--
-- A step's cost comes from token counts multiplied by a per-million-token
-- price. That product is fractional by construction: an OCR step came out at
-- 50.156 cents, and the insert failed because the column was `integer`. The
-- whole run failed with it — nine minutes of transcription and half a dollar
-- already spent with Anthropic, discarded at the moment of writing down what it
-- had cost.
--
-- Rounding at the write boundary would have been one line, and wrong. Steps
-- routinely cost fractions of a cent; rounding each of nine steps to the
-- nearest cent turns a 12-cent chapter into anything between 8 and 17, and the
-- cost dashboard exists precisely so those numbers can be trusted. The estimate
-- shown before launch is measured, not guessed, and the actual has to be
-- comparable to it.
--
-- numeric(14, 6): six decimal places is a millionth of a cent, which is finer
-- than any price in the table, and fourteen digits is more money than this
-- project will ever spend. Existing integer values convert exactly.

ALTER TABLE ingestion_steps
  ALTER COLUMN cost_cents TYPE numeric(14, 6) USING cost_cents::numeric(14, 6);

ALTER TABLE ingestion_runs
  ALTER COLUMN total_cost_cents TYPE numeric(14, 6) USING total_cost_cents::numeric(14, 6);

ALTER TABLE ingestion_runs
  ALTER COLUMN estimated_cost_cents TYPE numeric(14, 6) USING estimated_cost_cents::numeric(14, 6);
