
import json, os, urllib.request
token = os.environ["GH_TOKEN"]
req = urllib.request.Request(
    "https://api.github.com/graphql",
    data=json.dumps({"query": "query { viewer { login packages(first: 20, packageType: CONTAINER) { nodes { id name repository { name } } } } }"}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
)
with urllib.request.urlopen(req) as res:
    data = json.load(res)
print("errors", [e.get("message") for e in data.get("errors") or []])
nodes = ((data.get("data") or {}).get("viewer") or {}).get("packages", {}).get("nodes") or []
print("count", len(nodes))
want = {"nod-railway-server", "nod-railway-workspace", "nod-railway-browser"}
for node in nodes:
    repo = (node.get("repository") or {}).get("name")
    print(node["name"], repo)
    if node["name"] not in want:
        continue
    body = json.dumps({
        "query": "mutation($id:ID!){ updatePackageVisibility(input:{packageId:$id,visibility:PUBLIC}){ package { name } } }",
        "variables": {"id": node["id"]},
    }).encode()
    call = urllib.request.Request(
        "https://api.github.com/graphql",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(call) as res:
        out = json.load(res)
    print("update", [e.get("message") for e in out.get("errors") or []], out.get("data"))
