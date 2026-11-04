import { Modal } from '@/components/Modal'
import { GeneralConfigInfo } from '@/features/admin/components/GeneralConfigInfo'
import { IconsSection } from '@/features/admin/components/IconsSection'
import { SubmitSection } from '@/features/admin/components/SubmitSection'
import { SubmitStatus } from '@/features/admin/components/SubmitStatus'
import { VerificationLevels } from '@/features/admin/components/VerificationLevels'
import { ConfigForm } from '@/features/admin/providers/ConfigForm'
import { fetchBotConfig } from '@/lib/discord-integration-api/fetch-bot-config'
import { fetchAvailableGuildRoles } from '@/lib/discord/fetch-available-guild-roles'
import { userIsGuildAdmin } from '@/lib/discord/user-is-guild-admin'
import { authOptions } from '@/server/auth-options'
import { generateMetaTitle } from '@/utils/generate-meta-title'
import { prepareConfigFormInitialValues } from '@/utils/prepare-ui-bot-config'
import { routes } from '@/utils/routes'
import { getServerSession } from 'next-auth'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'

export const generateMetadata = async () => {
  const t = await getTranslations()
  return { title: generateMetaTitle(t('Discord_Integration_Admin_Meta_Title')) }
}

const AdminAccessMessage = ({ title, description }: { title: string; description: string }) => (
  <Modal className="max-w-[520px] w-full">
    <div role="alert" className="p-8 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-3 text-sm text-gray-300">{description}</p>
    </div>
  </Modal>
)

const Admin = async () => {
  const session = await getServerSession(authOptions)

  if (!session?.user?.id || !session?.guild?.id) {
    redirect(routes.signIn({ callbackUrl: routes.admin() }))
  }

  let isAdmin: boolean

  try {
    isAdmin = await userIsGuildAdmin(session.user.id, session.guild.id)
  } catch (error) {
    console.error('Error checking guild admin status', error)
    const t = await getTranslations()
    return (
      <AdminAccessMessage
        title={t('Discord_Integration_Admin_Check_Unavailable_Title')}
        description={t('Discord_Integration_Admin_Check_Unavailable_Description')}
      />
    )
  }

  if (!isAdmin) {
    const t = await getTranslations()
    return (
      <AdminAccessMessage
        title={t('Discord_Integration_Admin_Access_Denied_Title')}
        description={t('Discord_Integration_Admin_Access_Denied_Description')}
      />
    )
  }

  const guildId = session.guild.id

  const roles = await fetchAvailableGuildRoles(guildId)
  const botConfig = await fetchBotConfig(guildId)

  const initialConfigFormValues = prepareConfigFormInitialValues({
    botConfig,
    roles,
    guild_id: guildId,
  })

  return (
    <Modal className="max-w-[648px] w-full relative">
      <IconsSection className="absolute -top-15 -inset-x-0" />

      <ConfigForm initialValues={initialConfigFormValues}>
        <GeneralConfigInfo />
        <VerificationLevels initialRoles={roles} />
        <SubmitSection />
        <SubmitStatus className="absolute -bottom-8 inset-x-0" />
      </ConfigForm>
    </Modal>
  )
}

export default Admin
