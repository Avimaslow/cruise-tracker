from pathlib import Path
import kagglehub
from kagglehub import KaggleDatasetAdapter

OUT = Path(__file__).resolve().parents[1] / "data" / "ports.csv"
OUT.parent.mkdir(parents=True, exist_ok=True)

df = kagglehub.load_dataset(
    KaggleDatasetAdapter.PANDAS,
    "rajkumarpandey02/world-wide-port-index-data",
    "World_Port_Index.csv",
)

df = df[["PORT_NAME", "COUNTRY", "LATITUDE", "LONGITUDE"]].dropna()
df.to_csv(OUT, index=False)
print(f"Saved {len(df)} ports to {OUT}")
