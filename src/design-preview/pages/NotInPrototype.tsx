import { Link } from 'react-router-dom';
import { Blocks } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Button, Card, EmptyState } from '../../components/ui';
import { DESIGN_PREVIEW_PATH } from '../gate';

export default function NotInPrototype() {
  const { t } = useTranslation();
  return (
    <Card>
      <EmptyState
        icon={Blocks}
        title={t('preview.missing.title')}
        description={t('preview.missing.body')}
        action={
          <Button asChild variant="secondary">
            <Link to={DESIGN_PREVIEW_PATH}>{t('preview.missing.back')}</Link>
          </Button>
        }
      />
    </Card>
  );
}
