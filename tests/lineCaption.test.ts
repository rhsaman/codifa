// تست foldLineCaptions از طریق prepareContent:
// مدل گاهی "خط N: path" را قبل از بلوک کد می‌نویسد (با عدد فارسی یا رنج معکوس).
// باید شماره خط واقعی به فرمت lang:START-END درج شود و رنج معکوس normalize گردد.
import { prepareContent } from "../src/lib/bidi";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("❌ " + msg)
    process.exit(1)
  }
  console.log("✅ " + msg)
}

// ۱) رنج معکوس (خط ۲۰-۱۹) باید به ۱۹-۲۰ normalize شود
{
  const md = `کد در Plan.go خط ۲۰-۱۹ هست:
\`\`\`go
fromDate := time.Date(...)
isAfterCutoff := user.CreatedAt.After(fromDate)
\`\`\``
  const out = prepareContent(md)
  assert(out.includes("```go:19-20"), "رنج معکوس به ۱۹-۲۰ normalize شد: " + out.split("\n").find((l) => l.startsWith("```")))
  assert(!/خط ۲۰-۱۹/.test(out), "خط کپشن حذف شد")
}

// ۲) عدد فارسی (خط ۵۹) باید به لاتین تبدیل شود
{
  const md = `در Plan.go خط ۵۹:
\`\`\`go
if !isAfterCutoff {
\`\`\``
  const out = prepareContent(md)
  assert(out.includes("```go:59-59"), "عدد فارسی به ۵۹ تبدیل شد: " + out.split("\n").find((l) => l.startsWith("```")))
}

// ۳) بدون کپشن: بلوک دست‌نخورده بماند
{
  const md = "```go\nx := 1\n```"
  const out = prepareContent(md)
  assert(out === md, "بدون کپشن بلوک تغییر نکرد")
}

console.log("✅ تست lineCaption پاس شد")
