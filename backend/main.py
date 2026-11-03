import os
import boto3
from fastapi import FastAPI
from pydantic import BaseModel

MODEL_ID = os.getenv("MODEL_ID", "global.openai.gpt-6-sol")
bedrock = boto3.client("bedrock-runtime")
app = FastAPI()

class Ask(BaseModel):
    text: str

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.post("/api/ai/explain")
def explain(req: Ask):
    res = bedrock.converse(
        modelId=MODEL_ID,
        messages=[{"role": "user", "content": [{"text": req.text[:500]}]}],
        inferenceConfig={"maxTokens": 512},
    )
    texts = [b["text"] for b in res["output"]["message"]["content"] if "text" in b]
    return {"answer": "\n".join(texts)}
