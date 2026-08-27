p = "lib/store.ts"
s = open(p, encoding="utf-8").read()

s = s.replace(
    "      memoryTtlDays: typeof raw.memoryTtlDays === 'number' && raw.memoryTtlDays > 0 ? raw.memoryTtlDays : 180,\n"
    "      memoryMaxDocs: typeof raw.memoryMaxDocs === 'number' && raw.memoryMaxDocs >= 10 ? raw.memoryMaxDocs : 500,\n"
    "      memoryMaxChunks: typeof raw.memoryMaxChunks === 'number' && raw.memoryMaxChunks >= 50 ? raw.memoryMaxChunks : 4000,\n",
    "",
    1,
)

s = s.replace(
    "      taskTtlHours: typeof raw.memory?.taskTtlHours === 'number' && raw.memory.taskTtlHours > 0 ? raw.memory.taskTtlHours : 6,\n"
    "      shortTermTtlHours: typeof raw.memory?.shortTermTtlHours === 'number' && raw.memory.shortTermTtlHours > 0 ? raw.memory.shortTermTtlHours : 24,\n"
    "      longTermTtlHours: typeof raw.memory?.longTermTtlHours === 'number' && raw.memory.longTermTtlHours > 0 ? raw.memory.longTermTtlHours : 8760,\n"
    "      cacheTtlMinutes: typeof raw.memory?.cacheTtlMinutes === 'number' && raw.memory.cacheTtlMinutes > 0 ? raw.memory.cacheTtlMinutes : 60,\n"
    "      memoryMaxNotes: typeof raw.memory?.maxNotes === 'number' && raw.memory.maxNotes >= 20 ? raw.memory.maxNotes : 500,\n"
    "      memorySlidingTtl: typeof raw.memory?.slidingTtl === 'boolean' ? raw.memory.slidingTtl : true,\n",
    "      cacheTtlMinutes: typeof raw.memory?.cacheTtlMinutes === 'number' && raw.memory.cacheTtlMinutes > 0 ? raw.memory.cacheTtlMinutes : 60,\n",
    1,
)

open(p, "w", encoding="utf-8").write(s)
print("store.ts loadSettings updated")
