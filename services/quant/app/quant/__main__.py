"""`python -m app.quant <train|promote|clusters>` — Step 2.3 operator CLI."""

from app.quant.train import main

if __name__ == "__main__":
    raise SystemExit(main())
