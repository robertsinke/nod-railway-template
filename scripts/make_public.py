
import json, os, urllib.request
token = os.environ["GH_TOKEN"]

def gql(query, variables=None):
    payload = {"query": query}
    if variables:
        payload["variables"] = variables
    req = urllib.request.Request(
        "https://api.github.com/graphql",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as res:
        return json.load(res)

owner, name = os.environ.get("GITHUB_REPOSITORY", "inhouse-works/nod-railway-template").split("/", 1)
data = gql("""
query($owner:String!, $name:String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    packages(first: 20, packageType: DOCKER) { nodes { id name } }
  }
}
""", {"owner": owner, "name": name})
print("errors", [e.get("message") for e in data.get("errors") or []])
repo = ((data.get("data") or {}).get("repository") or {})
nodes = (repo.get("packages") or {}).get("nodes") or []
print("login", ((data.get("data") or {}).get("viewer") or {}).get("login"), "count", len(nodes))
want = {"nod-railway-server", "nod-railway-workspace", "nod-railway-browser"}
for node in nodes:
    print(node["name"])
    if node["name"] not in want:
        continue
    out = gql(
        "mutation($id:ID!){ updatePackageVisibility(input:{packageId:$id,visibility:PUBLIC}){ package { name } } }",
        {"id": node["id"]},
    )
    print("update", [e.get("message") for e in out.get("errors") or []], out.get("data"))
