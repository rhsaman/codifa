#!/usr/bin/env python3
"""
Compare our agent (coder) with opencode on:
1. Token usage
2. Speed (time to complete)
3. Quality (subjective + objective metrics)

Run with: python3 backend/test_compare_agents.py
"""

import asyncio
import json
import os
import sys
import time
import tempfile
import shutil
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Optional

# Add backend to path
sys.path.insert(0, os.path.dirname(__file__))

from agents import run_agent
from providers import env_key, is_opencode


@dataclass
class AgentResult:
    agent_name: str
    task: str
    success: bool
    time_seconds: float
    total_tokens: int
    input_tokens: int
    output_tokens: int
    tool_calls: int
    files_created: int
    files_modified: int
    error: Optional[str] = None
    output_preview: str = ""


async def run_our_agent(
    task: str,
    workspace: str,
    provider: str = "opencode",
    model: str = "qwen3-coder-480b",
    mode: str = "coder",
) -> AgentResult:
    """Run our agent on a task and collect metrics."""
    print(f"\n{'='*60}")
    print(f"Running OUR AGENT ({provider}/{model}) on task:")
    print(f"  {task[:80]}...")
    print(f"{'='*60}")
    
    start_time = time.time()
    total_tokens = 0
    input_tokens = 0
    output_tokens = 0
    tool_calls = 0
    output_chunks = []
    error = None
    success = False
    
    # Get API key
    api_key = env_key(provider)
    if not api_key:
        return AgentResult(
            agent_name=f"our-{provider}",
            task=task,
            success=False,
            time_seconds=0,
            total_tokens=0,
            input_tokens=0,
            output_tokens=0,
            tool_calls=0,
            files_created=0,
            files_modified=0,
            error=f"No API key for {provider}",
        )
    
    # Count files before
    files_before = set(Path(workspace).rglob("*")) if os.path.exists(workspace) else set()
    files_before = {f for f in files_before if f.is_file()}
    
    try:
        async for event in run_agent(
            provider=provider,
            model_name=model,
            base_url="",
            api_key=api_key,
            root=workspace,
            mode=mode,
            prompt=task,
            history=[],
            attachments=None,
            images=None,
            system_prompt="",
            thinking_level="medium",
            context_window=0,
            env_var="",
            oauth_token="",
            mcp_servers=None,
            skills=None,
            allow_create=False,
            cap=None,
            permission_gates=None,
            ask_gates=None,
            allow_outside=False,
            nvim_file="",
            nvim_diagnostics=None,
            vector_db_path="",
            vector_config=None,
            retrieval_config=None,
            subagent_models=None,
            chat_id="test-compare",
            reserved=None,
        ):
            # Collect usage events
            if event.get("kind") == "usage":
                usage = event
                total_tokens = usage.get("total_tokens", 0)
                input_tokens = usage.get("input_tokens", 0)
                output_tokens = usage.get("output_tokens", 0)
            
            # Count tool calls
            if event.get("kind") == "tool":
                tool_calls += 1
            
            # Collect output text
            if event.get("kind") == "text":
                output_chunks.append(event.get("content", ""))
            elif event.get("kind") == "error":
                error = event.get("content", "")
            
            # Print progress
            if event.get("kind") == "text":
                print(event.get("content", ""), end="", flush=True)
            elif event.get("kind") == "tool":
                print(f"\n[TOOL] {event.get('tool', 'unknown')}", flush=True)
        
        success = error is None
        output_text = "".join(output_chunks)
        
    except Exception as e:
        error = str(e)
        output_text = ""
        success = False
        print(f"\n[ERROR] {e}")
    
    elapsed = time.time() - start_time
    
    # Count files after
    files_after = set(Path(workspace).rglob("*")) if os.path.exists(workspace) else set()
    files_after = {f for f in files_after if f.is_file()}
    
    files_created = len(files_after - files_before)
    files_modified = 0
    for f in files_before & files_after:
        try:
            if f.stat().st_mtime > start_time:
                files_modified += 1
        except:
            pass
    
    print(f"\n\n--- RESULTS ---")
    print(f"  Time: {elapsed:.2f}s")
    print(f"  Tokens: {total_tokens} (in: {input_tokens}, out: {output_tokens})")
    print(f"  Tool calls: {tool_calls}")
    print(f"  Files created: {files_created}, modified: {files_modified}")
    print(f"  Success: {success}")
    if error:
        print(f"  Error: {error}")
    
    return AgentResult(
        agent_name=f"our-{provider}",
        task=task,
        success=success,
        time_seconds=elapsed,
        total_tokens=total_tokens,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        tool_calls=tool_calls,
        files_created=files_created,
        files_modified=files_modified,
        error=error,
        output_preview=output_text[:500],
    )


async def run_opencode_agent(
    task: str,
    workspace: str,
    model: str = "qwen3-coder-480b",
) -> AgentResult:
    """Run opencode on a task and collect metrics."""
    print(f"\n{'='*60}")
    print(f"Running OPENCODE ({model}) on task:")
    print(f"  {task[:80]}...")
    print(f"{'='*60}")
    
    start_time = time.time()
    
    # Count files before
    files_before = set(Path(workspace).rglob("*")) if os.path.exists(workspace) else set()
    files_before = {f for f in files_before if f.is_file()}
    
    # Run opencode
    cmd = [
        "opencode", "run",
        "--model", model,
        "--dir", workspace,
        "--print-logs",
        "--log-level", "WARN",
        task
    ]
    
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        elapsed = time.time() - start_time
        
        stdout_text = stdout.decode("utf-8", errors="replace")
        stderr_text = stderr.decode("utf-8", errors="replace")
        
        print(stdout_text)
        if stderr_text:
            print(f"[STDERR] {stderr_text}")
        
        success = proc.returncode == 0
        error = None if success else stderr_text[:500]
        
        # Try to extract token usage from opencode output
        # opencode prints token usage in logs
        total_tokens = 0
        input_tokens = 0
        output_tokens = 0
        tool_calls = 0
        
        # Parse opencode output for token info
        for line in stdout_text.split("\n"):
            if "tokens" in line.lower() or "usage" in line.lower():
                print(f"[TOKEN LINE] {line}")
        
    except Exception as e:
        elapsed = time.time() - start_time
        stdout_text = ""
        stderr_text = str(e)
        success = False
        error = str(e)
        total_tokens = 0
        input_tokens = 0
        output_tokens = 0
        tool_calls = 0
        print(f"\n[ERROR] {e}")
    
    # Count files after
    files_after = set(Path(workspace).rglob("*")) if os.path.exists(workspace) else set()
    files_after = {f for f in files_after if f.is_file()}
    
    files_created = len(files_after - files_before)
    files_modified = 0
    for f in files_before & files_after:
        try:
            if f.stat().st_mtime > start_time:
                files_modified += 1
        except:
            pass
    
    print(f"\n--- RESULTS ---")
    print(f"  Time: {elapsed:.2f}s")
    print(f"  Tokens: {total_tokens} (in: {input_tokens}, out: {output_tokens})")
    print(f"  Tool calls: {tool_calls}")
    print(f"  Files created: {files_created}, modified: {files_modified}")
    print(f"  Success: {success}")
    if error:
        print(f"  Error: {error}")
    
    return AgentResult(
        agent_name="opencode",
        task=task,
        success=success,
        time_seconds=elapsed,
        total_tokens=total_tokens,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        tool_calls=tool_calls,
        files_created=files_created,
        files_modified=files_modified,
        error=error,
        output_preview=stdout_text[:500],
    )


def print_comparison(results: list[AgentResult]):
    """Print a comparison table."""
    print(f"\n{'='*80}")
    print("COMPARISON RESULTS")
    print(f"{'='*80}")
    
    # Table header
    print(f"{'Metric':<25} {'Our Agent':<20} {'OpenCode':<20} {'Winner':<15}")
    print("-" * 80)
    
    # Time
    our_time = next((r.time_seconds for r in results if r.agent_name.startswith("our")), 0)
    oc_time = next((r.time_seconds for r in results if r.agent_name == "opencode"), 0)
    time_winner = "Our Agent" if our_time and our_time < oc_time else "OpenCode" if oc_time else "N/A"
    print(f"{'Time (s)':<25} {our_time:<20.2f} {oc_time:<20.2f} {time_winner:<15}")
    
    # Total tokens
    our_tokens = next((r.total_tokens for r in results if r.agent_name.startswith("our")), 0)
    oc_tokens = next((r.total_tokens for r in results if r.agent_name == "opencode"), 0)
    token_winner = "Our Agent" if our_tokens and our_tokens < oc_tokens else "OpenCode" if oc_tokens else "N/A"
    print(f"{'Total Tokens':<25} {our_tokens:<20} {oc_tokens:<20} {token_winner:<15}")
    
    # Input tokens
    our_in = next((r.input_tokens for r in results if r.agent_name.startswith("our")), 0)
    oc_in = next((r.input_tokens for r in results if r.agent_name == "opencode"), 0)
    print(f"{'Input Tokens':<25} {our_in:<20} {oc_in:<20} {'':<15}")
    
    # Output tokens
    our_out = next((r.output_tokens for r in results if r.agent_name.startswith("our")), 0)
    oc_out = next((r.output_tokens for r in results if r.agent_name == "opencode"), 0)
    print(f"{'Output Tokens':<25} {our_out:<20} {oc_out:<20} {'':<15}")
    
    # Tool calls
    our_tools = next((r.tool_calls for r in results if r.agent_name.startswith("our")), 0)
    oc_tools = next((r.tool_calls for r in results if r.agent_name == "opencode"), 0)
    print(f"{'Tool Calls':<25} {our_tools:<20} {oc_tools:<20} {'':<15}")
    
    # Files created
    our_files = next((r.files_created for r in results if r.agent_name.startswith("our")), 0)
    oc_files = next((r.files_created for r in results if r.agent_name == "opencode"), 0)
    print(f"{'Files Created':<25} {our_files:<20} {oc_files:<20} {'':<15}")
    
    # Success
    our_success = next((r.success for r in results if r.agent_name.startswith("our")), False)
    oc_success = next((r.success for r in results if r.agent_name == "opencode"), False)
    print(f"{'Success':<25} {str(our_success):<20} {str(oc_success):<20} {'':<15}")
    
    print("-" * 80)
    
    # Quality assessment
    print("\nQUALITY NOTES:")
    for r in results:
        print(f"\n  {r.agent_name}:")
        print(f"    Success: {r.success}")
        if r.error:
            print(f"    Error: {r.error}")
        print(f"    Output preview: {r.output_preview[:200]}...")


async def main():
    # Test tasks - coding tasks that both agents can handle
    tasks = [
        "Create a Python file fibonacci.py with a function that calculates the nth Fibonacci number using memoization. Include a main block that prints the first 20 numbers.",
        "Create a simple REST API using FastAPI in a file api.py with two endpoints: GET /health that returns {'status': 'ok'} and POST /echo that echoes back the JSON body.",
        "Write a Python script that reads a CSV file, filters rows where age > 30, and writes the result to a new CSV. Create sample data and the script.",
    ]
    
    # Use a temporary workspace for each task
    all_results = []
    
    for i, task in enumerate(tasks):
        print(f"\n\n{'#'*80}")
        print(f"TASK {i+1}/{len(tasks)}: {task}")
        print(f"{'#'*80}")
        
        # Create fresh workspace for each task
        with tempfile.TemporaryDirectory(prefix=f"agent_test_{i}_") as workspace:
            print(f"Workspace: {workspace}")
            
            # Run our agent
            our_result = await run_our_agent(task, workspace, provider="opencode", model="qwen3-coder-480b")
            
            # Create fresh workspace for opencode (to avoid interference)
            with tempfile.TemporaryDirectory(prefix=f"opencode_test_{i}_") as oc_workspace:
                # Copy any files our agent created (for fair comparison, start from same state)
                # Actually, let's start fresh for both
                oc_result = await run_opencode_agent(task, oc_workspace, model="qwen3-coder-480b")
            
            all_results.extend([our_result, oc_result])
            print_comparison([our_result, oc_result])
    
    # Summary
    print(f"\n{'='*80}")
    print("FINAL SUMMARY")
    print(f"{'='*80}")
    
    our_results = [r for r in all_results if r.agent_name.startswith("our")]
    oc_results = [r for r in all_results if r.agent_name == "opencode"]
    
    if our_results and oc_results:
        avg_our_time = sum(r.time_seconds for r in our_results) / len(our_results)
        avg_oc_time = sum(r.time_seconds for r in oc_results) / len(oc_results)
        avg_our_tokens = sum(r.total_tokens for r in our_results) / len(our_results)
        avg_oc_tokens = sum(r.total_tokens for r in oc_results) / len(oc_results)
        our_success_rate = sum(1 for r in our_results if r.success) / len(our_results)
        oc_success_rate = sum(1 for r in oc_results if r.success) / len(oc_results)
        
        print(f"\nAverage Time:     Our Agent: {avg_our_time:.2f}s  |  OpenCode: {avg_oc_time:.2f}s")
        print(f"Average Tokens:   Our Agent: {avg_our_tokens:.0f}  |  OpenCode: {avg_oc_tokens:.0f}")
        print(f"Success Rate:     Our Agent: {our_success_rate*100:.0f}%  |  OpenCode: {oc_success_rate*100:.0f}%")
        
        # Save results
        output_file = Path("agent_comparison_results.json")
        with open(output_file, "w") as f:
            json.dump([asdict(r) for r in all_results], f, indent=2)
        print(f"\nResults saved to {output_file}")


if __name__ == "__main__":
    asyncio.run(main())