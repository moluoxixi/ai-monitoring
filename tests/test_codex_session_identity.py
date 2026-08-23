import json

from scripts.codex_session_identity import is_subagent_session, read_session_identity, session_kind


def _write_session(root, thread_id, payload):
    path = root / "sessions" / "2026" / "08"
    path.mkdir(parents=True)
    (path / f"rollout-{thread_id}.jsonl").write_text(
        json.dumps({"type": "session_meta", "payload": {"session_id": thread_id, **payload}}) + "\n"
        + json.dumps({"type": "event_msg", "payload": {"type": "user_message", "message": "private"}}) + "\n",
        encoding="utf-8",
    )


def test_reads_subagent_object_source_without_returning_transcript(tmp_path):
    _write_session(tmp_path, "thread-object", {"source": {"subagent": {"thread_spawn": {}}}})

    assert is_subagent_session("thread-object", tmp_path) is True
    identity = read_session_identity("thread-object", tmp_path)
    assert identity["source"] == ""
    assert "private" not in json.dumps(identity)


def test_reads_subagent_thread_source_variant(tmp_path):
    _write_session(tmp_path, "thread-string", {"source": "vscode", "thread_source": "subagent"})

    assert is_subagent_session("thread-string", tmp_path) is True


def test_cli_thread_source_overrides_inherited_desktop_markers(tmp_path):
    _write_session(tmp_path, "thread-fork", {
        "source": "vscode", "originator": "Codex Desktop", "thread_source": "cli",
    })

    assert session_kind("thread-fork", tmp_path) == "codex-cli"


def test_subagent_identity_stays_higher_priority_than_cli_thread_source(tmp_path):
    _write_session(tmp_path, "thread-subagent-fork", {
        "source": {"type": "subagent"}, "originator": "Codex Desktop", "thread_source": "cli",
    })

    assert session_kind("thread-subagent-fork", tmp_path) == "subagent"


def test_unknown_session_is_not_assumed_to_be_subagent(tmp_path):
    assert is_subagent_session("missing", tmp_path) is False


def test_does_not_accept_a_filename_substring_with_a_different_session_id(tmp_path):
    _write_session(tmp_path, "foobar", {"source": {"subagent": {}}})

    assert is_subagent_session("foo", tmp_path) is False


def test_finds_parent_thread_id_in_a_child_rollout_header(tmp_path):
    path = tmp_path / "sessions" / "2026"
    path.mkdir(parents=True)
    (path / "rollout-child.jsonl").write_text(json.dumps({
        "type": "session_meta",
        "payload": {
            "session_id": "parent-thread",
            "source": {"subagent": {"thread_spawn": {"parent_thread_id": "parent-thread"}}},
            "thread_source": "subagent",
        },
    }) + "\n", encoding="utf-8")

    assert is_subagent_session("parent-thread", tmp_path) is True
    assert session_kind("parent-thread", tmp_path) == "subagent"
