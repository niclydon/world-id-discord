import { useTranslations } from 'next-intl'
import z from 'zod'

export const craftConfigFormSchema = (t: ReturnType<typeof useTranslations>) => {
  const role = z.object({ label: z.string(), value: z.string() })
  const rolesError = { message: t('Discord_Integration_VerificationLevels_Roles_Error') }

  return z
    .object({
      botEnabled: z.boolean(),
      deviceEnabled: z.boolean(),
      deviceRoles: z.array(role),
      orbEnabled: z.boolean(),
      orbRoles: z.array(role),
    })
    .superRefine((values, ctx) => {
      // A verification level needs at least one role only when it is
      // enabled. Requiring roles for a disabled level too made the form
      // unsavable in the common single-level setup (orb on, device off):
      // validation failed before any request was sent, and the page could
      // only report a generic save error.
      if (values.deviceEnabled && values.deviceRoles.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deviceRoles'], ...rolesError })
      }

      if (values.orbEnabled && values.orbRoles.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['orbRoles'], ...rolesError })
      }
    })
}

export type ConfigFormValues = z.infer<ReturnType<typeof craftConfigFormSchema>>
